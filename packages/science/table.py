"""Bounded CSV and XLSX reads with source row numbers."""

import csv
import io
import posixpath
import re
import zipfile
import zlib
from urllib.parse import unquote


MAX_BYTES = 8 * 1024 * 1024
MAX_ROWS = 25_000
MAX_COLUMNS = 256
MAX_CELLS = 500_000
XLSX_NS = {
    'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
    'http://purl.oclc.org/ooxml/spreadsheetml/main',
}
REL_NS = {
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
    'http://purl.oclc.org/ooxml/officeDocument/relationships',
}
PACKAGE_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
CONTENT_TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types'


def _csv(content):
    reader = csv.reader(io.StringIO(content.decode('utf-8-sig'), newline=''), strict=True)
    rows = []
    cells = 0
    while True:
        number = reader.line_num + 1
        values = next(reader, None)
        if values is None:
            return rows
        cells += len(values)
        if number > MAX_ROWS or len(values) > MAX_COLUMNS or cells > MAX_CELLS:
            raise ValueError('CSV exceeds row, column or cell limits')
        row = {index: value.strip() for index, value in enumerate(values) if value.strip()}
        if row:
            rows.append((number, row))


def _xml(archive, part, tag, namespaces):
    from lxml import etree

    parser = etree.XMLParser(resolve_entities=False, load_dtd=False, no_network=True,
                             recover=False, remove_comments=True, remove_pis=True)
    try:
        root = etree.fromstring(archive.read(part), parser)
    except (KeyError, etree.XMLSyntaxError) as error:
        raise ValueError(f'XLSX part {part!r} is missing or invalid XML') from error
    name = etree.QName(root)
    if root.getroottree().docinfo.doctype or name.localname != tag or name.namespace not in namespaces:
        raise ValueError(f'Invalid XLSX {tag} part {part!r}')
    return root, '{' + name.namespace + '}'


def _relationships(archive, part):
    folder, name = posixpath.split(part)
    rels, ns = _xml(archive, posixpath.join(folder, '_rels', name + '.rels'),
                    'Relationships', {PACKAGE_NS})
    result = {}
    for rel in rels.findall(ns + 'Relationship'):
        key = rel.get('Id')
        if not key or key in result:
            raise ValueError('XLSX relationship IDs must be present and unique')
        result[key] = rel
    return result


def _target(rel, kind, parent):
    if rel is None or rel.get('Type') not in {f'{ns}/{kind}' for ns in REL_NS}:
        raise ValueError(f'XLSX requires an internal {kind} relationship')
    target = unquote(rel.get('Target', ''))
    if (rel.get('TargetMode', 'Internal') != 'Internal' or not target
            or any(char in target for char in '\\:#?\x00') or target.startswith('//')):
        raise ValueError(f'Invalid internal XLSX {kind} target')
    part = posixpath.normpath(target[1:] if target.startswith('/') else
                             posixpath.join(posixpath.dirname(parent), target))
    if part in {'.', '..'} or part.startswith('../'):
        raise ValueError(f'Invalid XLSX {kind} target path')
    return part


def _by_kind(rels, kind):
    matches = [rel for rel in rels.values()
               if rel.get('Type') in {f'{ns}/{kind}' for ns in REL_NS}]
    if len(matches) > 1:
        raise ValueError(f'XLSX has multiple {kind} relationships')
    return next(iter(matches), None)


def _string(node, ns):
    # Rich-text phonetic annotations are metadata, not part of the cell text.
    return ''.join(text.text or '' for text in node.iterfind(
        f'{ns}r/{ns}t' if node.find(ns + 'r') is not None else ns + 't'))


def _cell_value(cell, ns, shared, location):
    if cell.find(ns + 'f') is not None:
        raise ValueError(f'{location}: formulas are unsupported; paste values first')
    kind = cell.get('t', 'n')
    values = cell.findall(ns + 'v')
    inline = cell.findall(ns + 'is')
    if kind == 'inlineStr' and len(inline) == 1 and not values:
        return _string(inline[0], ns)
    if inline or len(values) > 1 or kind not in {'n', 's'}:
        raise ValueError(f'{location}: unsupported or invalid XLSX cell type {kind!r}')
    value = values[0].text if values else None
    if kind == 's':
        if not value or not re.fullmatch(r'[0-9]{1,9}', value) or int(value) >= len(shared):
            raise ValueError(f'{location}: invalid XLSX shared-string index')
        return shared[int(value)]
    if value and not re.fullmatch(r'[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[Ee][+-]?[0-9]+)?', value):
        raise ValueError(f'{location}: invalid numeric XLSX value')
    return value or ''


def _worksheet(archive, part, name, shared):
    worksheet, ns = _xml(archive, part, 'worksheet', XLSX_NS)
    data = worksheet.findall(ns + 'sheetData')
    if len(data) != 1 or worksheet.find(ns + 'mergeCells') is not None:
        raise ValueError('Selected XLSX worksheet must have unmerged sheet data')
    rows = []
    previous = 0
    cells = 0
    for element in data[0].findall(ns + 'row'):
        ref = element.get('r', str(previous + 1))
        if not re.fullmatch(r'[1-9][0-9]{0,6}', ref) or not previous < int(ref) <= 1_048_576:
            raise ValueError('Invalid or out-of-order XLSX row index')
        number = previous = int(ref)
        if number > MAX_ROWS:
            raise ValueError('XLSX exceeds row limit')
        row = {}
        column = 0
        for cell in element.findall(ns + 'c'):
            cells += 1
            address = cell.get('r')
            index = column + 1
            if address is not None:
                match = re.fullmatch(r'([A-Z]{1,3})([1-9][0-9]{0,6})', address)
                if not match or int(match[2]) != number:
                    raise ValueError(f'Invalid XLSX cell address {address!r} in row {number}')
                index = 0
                for letter in match[1]:
                    index = index * 26 + ord(letter) - ord('A') + 1
            if not column < index <= MAX_COLUMNS or cells > MAX_CELLS:
                raise ValueError(f'XLSX row {number}: unordered cells or column/cell limit exceeded')
            column = index
            location = f'Sheet {name!r}, cell {address or f"row {number} column {column}"}'
            value = _cell_value(cell, ns, shared, location).strip()
            if value:
                row[index - 1] = value
        if row:
            rows.append((number, row))
    return rows


def _xlsx(content, sheet):
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        items = archive.infolist()
        names = {item.filename for item in items}
        if (len(items) > 256 or len(names) != len(items)
                or sum(item.file_size for item in items) > 32 * 1024 * 1024
                or any(item.file_size > MAX_BYTES or item.flag_bits & 1
                       or item.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}
                       for item in items)):
            raise ValueError('XLSX archive exceeds limits or has duplicate, encrypted or unsupported entries')
        bad_part = archive.testzip()
        if bad_part:
            raise ValueError(f'XLSX archive failed its CRC check for {bad_part!r}')
        _xml(archive, '[Content_Types].xml', 'Types', {CONTENT_TYPES_NS})
        workbook_part = _target(_by_kind(_relationships(archive, ''), 'officeDocument'),
                                'officeDocument', '')
        workbook, ns = _xml(archive, workbook_part, 'workbook', XLSX_NS)
        rels = _relationships(archive, workbook_part)
        sheets = {}
        for node in workbook.findall(f'{ns}sheets/{ns}sheet'):
            name = node.get('name')
            ids = [node.get(f'{{{uri}}}id') for uri in REL_NS if f'{{{uri}}}id' in node.attrib]
            if not name or name in sheets or len(ids) != 1:
                raise ValueError('Invalid or duplicate XLSX worksheet declaration')
            if ids[0] not in rels:
                raise ValueError(f'XLSX sheet {name!r} has no workbook relationship')
            sheets[name] = rels[ids[0]]
        if sheet is None:
            sheet = next((name for name, rel in sheets.items()
                          if rel.get('Type') in {f'{uri}/worksheet' for uri in REL_NS}), None)
        if sheet not in sheets:
            raise ValueError(f'XLSX worksheet {sheet!r} not found. Available sheets: {", ".join(sheets)}')
        part = _target(sheets[sheet], 'worksheet', workbook_part)
        shared = []
        reference = _by_kind(rels, 'sharedStrings')
        if reference is not None:
            strings, ns = _xml(archive, _target(reference, 'sharedStrings', workbook_part),
                               'sst', XLSX_NS)
            shared = [_string(item, ns) for item in strings.findall(ns + 'si')]
        return sheet, _worksheet(archive, part, sheet, shared)


def read_table(filename, content, sheet):
    if not content or len(content) > MAX_BYTES:
        raise ValueError('Upload must be nonempty and at most 8 MiB')
    try:
        if filename.lower().endswith('.csv'):
            if sheet is not None:
                raise ValueError('The sheet option applies only to XLSX files')
            return None, _csv(content)
        if filename.lower().endswith('.xlsx'):
            return _xlsx(content, sheet)
    except (UnicodeError, csv.Error) as error:
        raise ValueError(f'Invalid UTF-8 CSV: {error}') from error
    except (zipfile.BadZipFile, NotImplementedError, OSError, EOFError, zlib.error) as error:
        raise ValueError('Invalid or corrupt XLSX archive') from error
    raise ValueError('Upload a .csv or .xlsx file')
