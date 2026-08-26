#!/usr/bin/env python3
"""Busca replays donde un jugador use Jigglypuff (15) vs Young Link (21) y el oponente sea SLIM#536."""
import os
import sys
import struct
import ubjson

# IDs externos de slippi-js
JIGGLYPUFF = 15
YOUNG_LINK = 21

# Mapeo interno -> externo. La mayoria es identidad; Sheik/Zelda se intercambian.
def internal_to_external(internal_id):
    if internal_id == 0x07:
        return 0x13  # Sheik
    if internal_id == 0x13:
        return 0x12  # Zelda
    return internal_id


def read_metadata(path):
    with open(path, "rb") as f:
        data = f.read()

    if len(data) < 16:
        return None

    first = data[0]
    if first == 0x36:
        # formato muy antiguo, sin metadata
        return None
    if first != ord("{"):
        return None

    raw_data_position = 15
    # rawDataLength esta en bytes 11-14 big-endian
    raw_data_length = struct.unpack(">I", data[11:15])[0]
    if raw_data_length <= 0 or raw_data_length > len(data):
        return None

    metadata_position = raw_data_position + raw_data_length + 10
    metadata_length = len(data) - metadata_position - 1
    if metadata_length <= 0 or metadata_position + metadata_length > len(data):
        return None

    try:
        metadata = ubjson.loadb(data[metadata_position : metadata_position + metadata_length])
        return metadata
    except Exception as e:
        return None


def main(root_dir):
    matches = []
    for dirpath, _, filenames in os.walk(root_dir):
        for fname in filenames:
            if not fname.endswith(".slp"):
                continue
            path = os.path.join(dirpath, fname)
            metadata = read_metadata(path)
            if not metadata or "players" not in metadata:
                continue

            players = metadata["players"]
            if len(players) < 2:
                continue

            # Construir datos de cada jugador
            infos = []
            for idx, p in players.items():
                code = p.get("names", {}).get("code", "")
                usage = p.get("characterUsage", {})
                chars = {internal_to_external(int(k)) for k in usage.keys()}
                infos.append({"index": int(idx), "code": code, "chars": chars})

            for i, a in enumerate(infos):
                for b in infos[i + 1 :]:
                    if (
                        JIGGLYPUFF in a["chars"]
                        and YOUNG_LINK in b["chars"]
                        and "SLIM#536" in (a["code"] + b["code"])
                    ) or (
                        YOUNG_LINK in a["chars"]
                        and JIGGLYPUFF in b["chars"]
                        and "SLIM#536" in (a["code"] + b["code"])
                    ):
                        matches.append((path, a, b))

    if not matches:
        print("No se encontro ningun replay Jigglypuff vs Young Link contra SLIM#536.")
        return

    print(f"Encontrados {len(matches)} replay(s):")
    for path, a, b in matches:
        print(f"{path}")
        print(f"  Jugador A: {a['code']} chars={a['chars']}")
        print(f"  Jugador B: {b['code']} chars={b['chars']}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(f"Uso: {sys.argv[0]} /ruta/a/Slippi")
        sys.exit(1)
    main(sys.argv[1])
