// A stand-in Plex server (and Lidarr) for testing without a real account:
//   node tests/mock-plex.mjs [port]
// Serves a small fake library, tone "audio" with Range support, and logs interesting requests.
import http from "node:http";

const port = Number(process.argv[2] ?? 32400);
const artists = ["Massive Attack", "Aphex Twin", "Sigur Ros", "Boards of Canada", "Bonobo", "Burial", "Four Tet", "Portishead", "Radiohead", "Tycho"];
const albumNames = ["Mezzanine", "Ambient Works", "Agaetis byrjun", "Music Has the Right", "Black Sands", "Untrue", "There Is Love", "Dummy", "Kid A", "Dive"];
const titles = ["Teardrop", "Windowlicker", "Svefn", "Roygbiv", "Kong", "Archangel", "Angel Echoes", "Glory Box", "Idioteque", "Awake"];
const SECONDS = 40;

const album = (i) => ({ type: "album", ratingKey: String(100 + i), title: albumNames[i % 10] + (i >= 10 ? ` ${i}` : ""), parentTitle: artists[i % 10], parentRatingKey: String(10 + (i % 10)), thumb: `/thumb/${i}`, year: 1994 + (i % 20), leafCount: 10 });
const artist = (i) => ({ type: "artist", ratingKey: String(10 + i), title: artists[i % 10] + (i >= 10 ? ` ${i}` : ""), thumb: `/thumb/${i + 50}`, Similar: [{ tag: artists[(i + 1) % 10] }] });
const track = (i) => ({
  type: "track", ratingKey: String(1000 + i), title: titles[i % 10] + (i >= 10 ? ` ${i}` : ""), grandparentTitle: artists[i % 10], grandparentRatingKey: String(10 + (i % 10)),
  parentTitle: albumNames[i % 10], parentRatingKey: String(100 + (i % 10)), parentThumb: `/thumb/${i % 10}`, duration: SECONDS * 1000, index: (i % 10) + 1, parentIndex: 1,
  Media: [{ audioCodec: i % 2 ? "mp3" : "flac", bitrate: 900, Part: [{ key: `/library/parts/${1000 + i}/file.wav`, Stream: [{ streamType: 2, id: 5000 + i, gain: "-6.5", albumGain: "-5" }] }] }],
});
const mc = (o) => ({ MediaContainer: o });

// 40 s of a soft stereo tone.
function tone(freq) {
  const rate = 22050;
  const n = rate * SECONDS;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVEfmt ", 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 3000), 44 + i * 2);
  return buf;
}
const tones = new Map();

const lidarrArtist = { foreignArtistId: "mb-a1", artistName: "Requested Artist", images: [] };
const lidarrAlbum = { foreignAlbumId: "mb-r1", title: "Requested Album", releaseDate: "2020-01-01", albumType: "Album", artist: lidarrArtist, images: [] };

function route(p, q, req, body) {
  if (p === "/identity") return mc({ machineIdentifier: "mock", version: "1" });
  if (p.startsWith("/hubs/sections")) return mc({ Hub: [
    { hubIdentifier: "recent", title: "Recently added", type: "album", Metadata: [...Array(12)].map((_, i) => album(i)) },
    { hubIdentifier: "artists", title: "Artists you love", type: "artist", Metadata: [...Array(10)].map((_, i) => artist(i)) },
    { hubIdentifier: "more", title: "More in Electronic", type: "album", Metadata: [...Array(8)].map((_, i) => album(i + 3)) },
  ] });
  if (p.startsWith("/hubs/search")) return mc({ Hub: [
    { hubIdentifier: "t", title: "Tracks", type: "track", Metadata: [0, 1, 2, 3].map(track) },
    { hubIdentifier: "a", title: "Artists", type: "artist", Metadata: [0, 1].map(artist) },
    { hubIdentifier: "al", title: "Albums", type: "album", Metadata: [0, 1, 2].map(album) },
  ] });
  if (/^\/library\/sections\/\d+\/all/.test(p)) {
    const type = q.get("type");
    const n = type === "8" ? 40 : 60;
    const start = +q.get("X-Plex-Container-Start") || 0;
    const size = +q.get("X-Plex-Container-Size") || 50;
    const all = [...Array(n)].map((_, i) => (type === "8" ? artist(i) : type === "10" ? track(i) : album(i)));
    return mc({ totalSize: n, size: Math.min(size, n - start), Metadata: all.slice(start, start + size) });
  }
  if (p === "/playlists") return mc({ Metadata: ["Late night", "Running", "Focus"].map((t, i) => ({ type: "playlist", ratingKey: String(500 + i), title: t, leafCount: 10, duration: 400000, smart: 0 })) });
  if (/^\/playlists\/\d+\/items/.test(p)) return mc({ Metadata: [...Array(10)].map((_, i) => track(i)) });
  if (p === "/status/sessions") return mc({ Metadata: [] });
  if (p === "/:/timeline" || p === "/:/scrobble") {
    console.log(`${p} state=${q.get("state")} key=${q.get("ratingKey")} time=${q.get("time")} device=${req.headers["x-plex-device-name"]} product=${req.headers["x-plex-product"]}`);
    return {};
  }
  if (/\/nearest$/.test(p)) return mc({ Metadata: [...Array(12)].map((_, i) => track(i + 20)) });
  if (/\/library\/streams\/\d+\/levels/.test(p)) return mc({ Level: [...Array(140)].map((_, i) => ({ v: -30 + 20 * Math.abs(Math.sin(i / 7)) })) });
  const m = p.match(/^\/library\/metadata\/(\d+)(\/children|\/allLeaves)?/);
  if (m) {
    const id = +m[1];
    if (m[2]) return mc({ Metadata: id < 100 && m[2] === "/children" ? [0, 1, 2].map((i) => album(i + id - 10)) : [...Array(10)].map((_, i) => track(i)) });
    return mc({ Metadata: [id >= 1000 ? track(id - 1000) : id >= 100 ? { ...album(id - 100), Genre: [{ tag: "Trip hop" }] } : artist(id - 10)] });
  }
  // Lidarr
  if (p === "/api/v1/rootfolder") return [{ path: "/music" }];
  if (p === "/api/v1/qualityprofile") return [{ id: 1, name: "Lossless" }];
  if (p === "/api/v1/metadataprofile") return [{ id: 2, name: "Standard" }];
  if (p === "/api/v1/artist/lookup") return [lidarrArtist];
  if (p === "/api/v1/album/lookup") return [lidarrAlbum];
  if ((p === "/api/v1/artist" || p === "/api/v1/album") && req.method === "POST") {
    console.log(`LIDARR ${p} key=${req.headers["x-api-key"]} ${body.slice(0, 300)}`);
    return { id: 7 };
  }
  return mc({});
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (process.env.MOCK_VERBOSE) console.log(req.method, req.url.slice(0, 110));
    const p = url.pathname;
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      const part = p.match(/^\/library\/parts\/(\d+)\//);
      if (part) {
        const f = 180 + (+part[1] % 10) * 40;
        if (!tones.has(f)) tones.set(f, tone(f));
        const data = tones.get(f);
        const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
        const start = range ? +range[1] : 0;
        const end = range && range[2] ? +range[2] : data.length - 1;
        res.writeHead(range ? 206 : 200, { "Content-Type": "audio/wav", "Accept-Ranges": "bytes", "Content-Length": end - start + 1, ...(range ? { "Content-Range": `bytes ${start}-${end}/${data.length}` } : {}) });
        return res.end(data.subarray(start, end + 1));
      }
      if (p === "/__css") return res.end(process.env.MOCK_CSS ?? "");
      if (p.startsWith("/photo/")) {
        const n = Number((url.searchParams.get("url") ?? "").split("/").pop()) || 0;
        const size = url.searchParams.get("width") ?? 300;
        const hue = (n * 47) % 360;
        res.writeHead(200, { "Content-Type": "image/svg+xml" });
        return res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="hsl(${hue},70%,55%)"/><stop offset="1" stop-color="hsl(${hue + 60},70%,30%)"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`);
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(route(p, url.searchParams, req, Buffer.concat(chunks).toString())));
    });
  })
  .listen(port, "0.0.0.0", () => console.log(`mock plex on ${port}`));
