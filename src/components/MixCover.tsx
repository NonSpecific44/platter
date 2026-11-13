import { useEffect, useState } from "react";
import { MIX_LABEL, type Mix } from "../mixes";
import { mixArt, savedArt } from "../mixArt";

/** A Made for you mix's drawn cover; the last one drawn shows until this mix's is ready. */
export function MixCover({ id, mix, className = "" }: { id: Mix["id"]; mix?: Mix; className?: string }) {
  const [url, setUrl] = useState(() => savedArt(id));
  useEffect(() => {
    if (!mix?.tracks.length) return;
    let live = true;
    mixArt(mix).then((u) => live && setUrl(u), () => undefined);
    return () => {
      live = false;
    };
  }, [mix]);
  const label = MIX_LABEL[id];
  return (
    <div className={`cover mix-art mix-${id} ${className}`}>
      {url ? <img src={url} alt="" draggable={false} /> : <span>{label}</span>}
    </div>
  );
}
