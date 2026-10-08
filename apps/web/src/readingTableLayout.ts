/** Annotate only an unambiguous rectangular table; retain the original cell DOM. */
export function prepareReadingTable(table: HTMLTableElement, prefix: string): boolean {
  const head = table.tHead;
  const body = table.tBodies[0];
  if (
    !head ||
    head.rows.length !== 1 ||
    table.tBodies.length !== 1 ||
    !body ||
    !body.rows.length ||
    body.rows.length > 64 ||
    table.tFoot ||
    table.parentElement?.closest('table') ||
    table.querySelector('table, [colspan], [rowspan], [headers], .math.display') ||
    (table.textContent?.length ?? 0) > 65536
  )
    return false;
  const headers = [...head.rows[0]!.cells];
  if (
    headers.length < 3 ||
    headers.length > 12 ||
    headers.some(
      (cell) =>
        cell.tagName !== 'TH' ||
        !cell.textContent?.trim() ||
        cell.querySelector('a, [id]') ||
        (cell.hasAttribute('scope') && cell.scope !== 'col'),
    ) ||
    [...body.rows].some(
      (row) =>
        row.cells.length !== headers.length || [...row.cells].some((cell) => cell.tagName !== 'TD'),
    )
  )
    return false;
  table.classList.add('reading-card-table');
  table.setAttribute('role', 'table');
  head.setAttribute('role', 'rowgroup');
  body.setAttribute('role', 'rowgroup');
  head.rows[0]!.setAttribute('role', 'row');
  for (const [column, header] of headers.entries()) {
    if (!header.id) {
      let id = `${prefix}-${column}`;
      while (table.ownerDocument.getElementById(id)) id += '-column';
      header.id = id;
    }
    header.scope = 'col';
    header.setAttribute('role', 'columnheader');
  }
  for (const row of body.rows) {
    row.setAttribute('role', 'row');
    for (const [column, cell] of [...row.cells].entries()) {
      const header = headers[column]!;
      cell.setAttribute('role', 'cell');
      cell.setAttribute('headers', header.id);
      const label = table.ownerDocument.createElement('span');
      label.className = 'reading-card-label';
      label.setAttribute('aria-hidden', 'true');
      label.innerHTML = header.innerHTML;
      const value = table.ownerDocument.createElement('span');
      value.className = 'reading-card-value';
      value.append(...cell.childNodes);
      cell.append(label, value);
    }
  }
  return true;
}
