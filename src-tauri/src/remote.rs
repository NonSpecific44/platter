//! Remote control between Platter devices (and from other Plex apps).
//!
//! Each Platter runs a small HTTP server speaking the Plex Companion protocol, plus its own
//! `/tonearm/*` endpoints (named from before the app was renamed; kept for compatibility). The server only moves bytes: every request is handed to the frontend
//! (`remote://request`), which answers through `remote_reply`, so the protocol logic is shared
//! between desktop and Android. Discovery uses Plex's GDM: a multicast "M-SEARCH" on
//! 239.0.0.250:32412 that players answer with their name and port.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
use std::net::{Ipv4Addr, SocketAddrV4, UdpSocket};
use std::sync::atomic::{AtomicU16, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

const GDM_ADDR: Ipv4Addr = Ipv4Addr::new(239, 0, 0, 250);
const GDM_PORT: u16 = 32412;
const DISCOVERY_PORT: u16 = 32414;
const PORTS: std::ops::RangeInclusive<u16> = 32500..=32510;
/// Long-polls wait up to 30 s on the frontend; leave room for the reply.
const REPLY_TIMEOUT: Duration = Duration::from_secs(40);

#[derive(Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    name: String,
    client_id: String,
    product: String,
    version: String,
    device_class: String,
}

#[derive(Default)]
pub struct Remote {
    pending: Mutex<HashMap<u64, Sender<Reply>>>,
    next_id: AtomicU64,
    port: AtomicU16,
    identity: Mutex<Option<Identity>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    id: u64,
    method: String,
    path: String,
    query: HashMap<String, String>,
    headers: HashMap<String, String>,
    body: String,
    from: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reply {
    id: u64,
    status: u16,
    content_type: String,
    body: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    name: String,
    host: String,
    port: u16,
    client_id: String,
    product: String,
    device_class: String,
}

pub fn start(app: AppHandle) {
    app.manage(Arc::new(Remote::default()));
    let remote = app.state::<Arc<Remote>>().inner().clone();
    let server = PORTS.clone().find_map(|p| {
        tiny_http::Server::http(("0.0.0.0", p)).ok().map(|s| (s, p))
    });
    let Some((server, port)) = server else {
        eprintln!("remote control unavailable: ports {PORTS:?} are all in use");
        return;
    };
    remote.port.store(port, Ordering::Relaxed);
    let server = Arc::new(server);
    {
        let app = app.clone();
        let remote = remote.clone();
        std::thread::spawn(move || {
            for req in server.incoming_requests() {
                let app = app.clone();
                let remote = remote.clone();
                std::thread::spawn(move || handle(&app, &remote, req));
            }
        });
    }
    std::thread::spawn(move || gdm_responder(&remote));
}

fn cors(mut resp: tiny_http::Response<std::io::Cursor<Vec<u8>>>) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    for (k, v) in [
        ("Access-Control-Allow-Origin", "*"),
        ("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS"),
        ("Access-Control-Allow-Headers", "*"),
        ("Access-Control-Max-Age", "1209600"),
    ] {
        resp.add_header(tiny_http::Header::from_bytes(k, v).unwrap());
    }
    resp
}

fn handle(app: &AppHandle, remote: &Remote, mut req: tiny_http::Request) {
    if *req.method() == tiny_http::Method::Options {
        let _ = req.respond(cors(tiny_http::Response::from_data(Vec::new())));
        return;
    }
    let url = req.url().to_string();
    let (path, qs) = url.split_once('?').unwrap_or((&url, ""));
    let query = qs
        .split('&')
        .filter(|p| !p.is_empty())
        .map(|p| {
            let (k, v) = p.split_once('=').unwrap_or((p, ""));
            (decode(k), decode(v))
        })
        .collect();
    let headers = req
        .headers()
        .iter()
        .map(|h| (h.field.as_str().as_str().to_ascii_lowercase(), h.value.as_str().to_string()))
        .collect();
    let mut body = String::new();
    let _ = req.as_reader().take(4 << 20).read_to_string(&mut body);
    let id = remote.next_id.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = channel();
    remote.pending.lock().unwrap().insert(id, tx);
    let request = Request {
        id,
        method: req.method().as_str().to_string(),
        path: path.to_string(),
        query,
        headers,
        body,
        from: req.remote_addr().map(|a| a.ip().to_string()).unwrap_or_default(),
    };
    let reply = if app.emit("remote://request", request).is_ok() { rx.recv_timeout(REPLY_TIMEOUT).ok() } else { None };
    remote.pending.lock().unwrap().remove(&id);
    let reply = reply.unwrap_or(Reply { id, status: 503, content_type: "text/plain".into(), body: "not ready".into() });
    let mut resp = tiny_http::Response::from_data(reply.body.into_bytes()).with_status_code(reply.status);
    resp.add_header(tiny_http::Header::from_bytes("Content-Type", reply.content_type).unwrap());
    if let Some(i) = remote.identity.lock().unwrap().as_ref() {
        resp.add_header(tiny_http::Header::from_bytes("X-Plex-Client-Identifier", i.client_id.as_str()).unwrap());
    }
    let _ = req.respond(cors(resp));
}

fn decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = bytes
            .get(i + 1..i + 3)
            .and_then(|h| std::str::from_utf8(h).ok())
            .and_then(|h| u8::from_str_radix(h, 16).ok());
        match (bytes[i], hex) {
            (b'%', Some(b)) => {
                out.push(b);
                i += 2;
            }
            (b'+', _) => out.push(b' '),
            (b, _) => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ---- GDM -------------------------------------------------------------------------

fn gdm_reply(remote: &Remote) -> Option<String> {
    let i = remote.identity.lock().unwrap().clone()?;
    Some(format!(
        "HTTP/1.0 200 OK\r\nContent-Type: plex/media-player\r\nResource-Identifier: {}\r\nName: {}\r\nPort: {}\r\n\
         Product: {}\r\nVersion: {}\r\nProtocol: plex\r\nProtocol-Version: 1\r\n\
         Protocol-Capabilities: timeline,playback,playqueues\r\nDevice-Class: {}\r\n\r\n",
        i.client_id,
        i.name,
        remote.port.load(Ordering::Relaxed),
        i.product,
        i.version,
        i.device_class
    ))
}

fn gdm_responder(remote: &Remote) {
    let sock = (|| -> std::io::Result<UdpSocket> {
        use socket2::{Domain, Protocol, Socket, Type};
        let s = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
        s.set_reuse_address(true)?;
        #[cfg(unix)]
        s.set_reuse_port(true)?;
        s.bind(&SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, GDM_PORT).into())?;
        s.join_multicast_v4(&GDM_ADDR, &Ipv4Addr::UNSPECIFIED)?;
        Ok(s.into())
    })();
    let Ok(sock) = sock else {
        eprintln!("GDM discovery responder unavailable");
        return;
    };
    let mut buf = [0u8; 2048];
    while let Ok((n, from)) = sock.recv_from(&mut buf) {
        if !buf[..n].starts_with(b"M-SEARCH") {
            continue;
        }
        if let Some(reply) = gdm_reply(remote) {
            let _ = sock.send_to(reply.as_bytes(), from);
        }
    }
}

fn parse_gdm(text: &str) -> HashMap<String, String> {
    text.lines()
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
        .collect()
}

// ---- commands --------------------------------------------------------------------

#[tauri::command]
pub fn remote_reply(remote: State<Arc<Remote>>, reply: Reply) {
    if let Some(tx) = remote.pending.lock().unwrap().remove(&reply.id) {
        let _ = tx.send(reply);
    }
}

/// Port the companion server listens on (0 if it couldn't start).
#[tauri::command]
pub fn remote_identity(remote: State<Arc<Remote>>, identity: Identity) -> u16 {
    *remote.identity.lock().unwrap() = Some(identity);
    remote.port.load(Ordering::Relaxed)
}

#[tauri::command]
pub fn remote_hostname() -> String {
    std::fs::read_to_string("/proc/sys/kernel/hostname")
        .map(|h| h.trim().to_string())
        .ok()
        .filter(|h| !h.is_empty() && h != "localhost")
        .unwrap_or_default()
}

/// Asks the LAN for Plex players; returns whoever answers within `ms`.
#[tauri::command]
pub async fn remote_discover(ms: Option<u64>) -> Result<Vec<Device>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // A fixed port so a firewall can let the answers in (see packaging/ufw/platter).
        let sock = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, DISCOVERY_PORT))
            .or_else(|_| UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)))
            .map_err(|e| e.to_string())?;
        let _ = sock.set_multicast_ttl_v4(2);
        sock.send_to(b"M-SEARCH * HTTP/1.1\r\n\r\n", (GDM_ADDR, GDM_PORT)).map_err(|e| e.to_string())?;
        let deadline = Instant::now() + Duration::from_millis(ms.unwrap_or(1500));
        let mut found: Vec<Device> = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            let _ = sock.set_read_timeout(Some(left));
            let Ok((n, from)) = sock.recv_from(&mut buf) else { break };
            let h = parse_gdm(&String::from_utf8_lossy(&buf[..n]));
            if !h.get("content-type").is_some_and(|t| t.contains("player")) {
                continue;
            }
            let client_id = h.get("resource-identifier").cloned().unwrap_or_default();
            if found.iter().any(|d| d.client_id == client_id) {
                continue;
            }
            found.push(Device {
                name: h.get("name").cloned().unwrap_or_default(),
                host: from.ip().to_string(),
                port: h.get("port").and_then(|p| p.parse().ok()).unwrap_or(32500),
                client_id,
                product: h.get("product").cloned().unwrap_or_default(),
                device_class: h.get("device-class").cloned().unwrap_or_default(),
            });
        }
        Ok(found)
    })
    .await
    .map_err(|e| e.to_string())?
}
