import { useState } from "react";
import { getStockIconPath } from "@/lib/stockIcons";

interface StockIconProps {
  characterId?: number | null;
  costumeId?: number | null;
  size?: number;
  className?: string;
  alt?: string;
}

export function StockIcon({ characterId, costumeId, size = 20, className = "", alt }: StockIconProps) {
  const [failed, setFailed] = useState(false);
  const src = getStockIconPath(characterId, costumeId);

  if (failed) {
    return (
      <span
        className={`inline-flex items-center justify-center rounded bg-muted text-[10px] font-bold text-muted-foreground ${className}`}
        style={{ width: size, height: size }}
        title={alt || "?"}
      >
        ?
      </span>
    );
  }

  return (
    <img
      src={src}
      alt={alt || "stock"}
      className={`inline-block object-contain ${className}`}
      style={{ width: size, height: size }}
      onError={() => setFailed(true)}
    />
  );
}
