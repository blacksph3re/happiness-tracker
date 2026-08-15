"""Rendering tabular data for download.

Both halves export, and both export the same shape — a header row and rows of
scalars — so the rendering lives here rather than twice over in the routers.
"""

import csv
from collections.abc import Iterable, Sequence
from io import StringIO

# Excel reads a CSV as the system's legacy codepage unless the file opens with a
# byte-order mark, which turns a project called "Büro" into mojibake in the one
# program most likely to open this.
BOM = "﻿"


def as_csv(rows: Iterable[Sequence[object]]) -> bytes:
    """Render rows as UTF-8 CSV, ready to attach to a response.

    Parameters
    ----------
    rows : iterable of sequence
        The header row followed by the body. ``None`` cells are written empty
        rather than as the text "None".

    Returns
    -------
    bytes
        The encoded document, starting with a byte-order mark.
    """
    buffer = StringIO(newline="")
    writer = csv.writer(buffer)
    for row in rows:
        writer.writerow(["" if cell is None else cell for cell in row])
    return (BOM + buffer.getvalue()).encode("utf-8")
