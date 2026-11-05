// Edit a local file's tags, with a MusicBrainz lookup for when the scan couldn't match it.
import { useEffect, useState } from "react";
import { Loader2, Search, X } from "lucide-react";
import { useMetadataEditor } from "../actions";
import { TagFields, fieldsFor, saveTags } from "../local";
import { Recording, coverArtUrl, searchRecordings } from "../musicbrainz";
import { toast } from "../store";

const TEXT: [keyof TagFields, string][] = [
  ["title", "Title"],
  ["artist", "Artist"],
  ["album", "Album"],
  ["albumArtist", "Album artist"],
  ["genre", "Genre"],
];
const NUMBERS: [keyof TagFields, string][] = [
  ["track", "Track"],
  ["disc", "Disc"],
  ["year", "Year"],
];

export function MetadataEditor() {
  const track = useMetadataEditor((s) => s.track);
  const close = () => useMetadataEditor.getState().edit(null);
  const [fields, setFields] = useState<TagFields | null>(null);
  const [results, setResults] = useState<Recording[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [cover, setCover] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setFields(track?.local ? fieldsFor(track.local) : null);
    setResults(null);
    setCover(undefined);
  }, [track]);

  if (!track?.local || !fields) return null;
  const change = (k: keyof TagFields, v: string | number | null) => setFields({ ...fields, [k]: v });
  const search = async () => {
    setSearching(true);
    try {
      setResults(await searchRecordings(fields.artist, fields.title, fields.album));
    } catch (e) {
      toast(`Couldn't search MusicBrainz: ${e}`, { error: true });
    }
    setSearching(false);
  };
  const apply = (r: Recording) => {
    setFields({ ...fields, title: r.title, artist: r.artist, album: r.album || fields.album, year: r.year ?? fields.year, track: r.track ?? fields.track });
    setCover(r.releaseId ? coverArtUrl(r.releaseId) : undefined);
    setResults(null);
  };
  const save = async () => {
    setSaving(true);
    const written = await saveTags(track.local!, fields, cover);
    setSaving(false);
    toast(written ? "Metadata saved to the file" : "Saved in Platter (Android doesn't allow changing this file)");
    close();
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal meta-editor">
        <div className="sheet-head">
          <h3>Edit metadata</h3>
          <button className="icon-btn" onClick={close} title="Close">
            <X size={18} />
          </button>
        </div>
        <p className="dim small meta-path">{track.local}</p>
        {results ? (
          <div className="meta-results">
            {results.map((r) => (
              <button key={r.id} className="meta-result" onClick={() => apply(r)}>
                <span className="meta-result-title">{r.title}</span>
                <span className="dim small">
                  {r.artist}
                  {r.album && ` · ${r.album}`}
                  {r.year && ` · ${r.year}`}
                </span>
              </button>
            ))}
            {!results.length && <p className="dim small">No matches. Try editing the title or artist, then search again.</p>}
            <button className="btn ghost" onClick={() => setResults(null)}>
              Back to fields
            </button>
          </div>
        ) : (
          <>
            {TEXT.map(([k, label]) => (
              <label className="meta-field" key={k}>
                <span>{label}</span>
                <input className="text-input" value={String(fields[k] ?? "")} onChange={(e) => change(k, e.target.value)} />
              </label>
            ))}
            <div className="meta-numbers">
              {NUMBERS.map(([k, label]) => (
                <label className="meta-field" key={k}>
                  <span>{label}</span>
                  <input
                    className="text-input"
                    inputMode="numeric"
                    value={fields[k] === null ? "" : String(fields[k])}
                    onChange={(e) => change(k, e.target.value.trim() === "" ? null : parseInt(e.target.value, 10) || 0)}
                  />
                </label>
              ))}
            </div>
            {cover && <p className="dim small">Cover art from MusicBrainz will be added.</p>}
            <div className="row gap meta-actions">
              <button className="btn" onClick={search} disabled={searching}>
                {searching ? <Loader2 className="spin" size={15} /> : <Search size={15} />} Search online
              </button>
              <div className="grow" />
              <button className="btn ghost" onClick={close}>
                Cancel
              </button>
              <button className="btn primary" onClick={save} disabled={saving}>
                Save
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
