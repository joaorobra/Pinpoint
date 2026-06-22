import { useEffect, useState } from "react";
import { api } from "../api";
import type { AssetData } from "../types";

interface Props {
  /** Vault-relative path of the non-markdown file to preview. */
  relPath: string;
}

/** Renders a non-markdown vault file — images inline, PDFs in an embed, text in a <pre>. */
export default function AssetViewer({ relPath }: Props) {
  const [asset, setAsset] = useState<AssetData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let revoked: string | null = null;
    let cancelled = false;
    setAsset(null);
    setError(null);
    api
      .readAsset(relPath)
      .then((a) => {
        if (cancelled) {
          // Component unmounted before load finished — release any object URL we created.
          if (a.url.startsWith("blob:")) URL.revokeObjectURL(a.url);
          return;
        }
        if (a.url.startsWith("blob:")) revoked = a.url;
        setAsset(a);
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [relPath]);

  const name = relPath.split("/").pop() ?? relPath;

  if (error) return <div className="empty">Could not open {name}: {error}</div>;
  if (!asset) return <div className="empty">Loading {name}…</div>;

  return (
    <div className="asset-viewer">
      {asset.kind === "image" && <img src={asset.url} alt={name} className="asset-image" />}
      {asset.kind === "pdf" && <iframe src={asset.url} title={name} className="asset-pdf" />}
      {asset.kind === "text" && <pre className="asset-text">{asset.url}</pre>}
      {asset.kind === "other" && (
        <div className="empty">
          {name} can't be previewed ({asset.mime || "unknown type"}).
        </div>
      )}
    </div>
  );
}
