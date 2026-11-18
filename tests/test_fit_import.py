import csv
import io
import json
import math
import unittest
import zipfile
from xml.sax.saxutils import escape

from jsonschema import ValidationError

from packages.science.fit import _student_95, analyze
from packages.science.kinetics import GAS_CONSTANT_J_PER_MOL_K, validate_result


def demo():
    """Return an Arrhenius CSV with training and independent holdout batches."""
    output = io.StringIO(newline='')
    writer = csv.writer(output)
    writer.writerow(['temperature_C', 'value', 'batch_id', 'relative_uncertainty', 'partition'])
    for index, (temperature, batch, split) in enumerate([
        (35, 'A', 'train'), (45, 'B', 'train'), (55, 'A', 'train'), (65, 'B', 'train'),
        (75, 'A', 'train'), (55, 'C', 'holdout'), (85, 'C', 'holdout'),
    ]):
        rate = 2.5e7 * math.exp(-52000 / (GAS_CONSTANT_J_PER_MOL_K * (temperature + 273.15)))
        writer.writerow([temperature, rate * math.exp(0.015 * (-1)**index), batch, 0.03, split])
    return 'arrhenius-demo.csv', output.getvalue().encode(), {}


def demo_xlsx():
    """Return an XLSX with custom columns, rich shared text and sparse row addresses."""
    main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
    package = 'http://schemas.openxmlformats.org/package/2006/relationships'
    content_type = 'application/vnd.openxmlformats-officedocument.spreadsheetml'
    headers = ['Bath Temp', 'Initial Rate', 'Run Batch', 'Relative SD', 'Split',
               'A Loading', 'B Loading', 'Conversion']
    columns = 'ACDEFGHJ'
    shared = ['<si><r><t>Bath</t></r><r><t xml:space="preserve"> Temp</t></r></si>']
    shared += [f'<si><t>{escape(header)}</t></si>' for header in headers[1:]]
    cells = ''.join(f'<c r="{col}2" t="s"><v>{index}</v></c>'
                    for index, col in enumerate(columns))
    rows = [f'<row r="2">{cells}</row>']
    for index, (a, b) in enumerate([(10, 20), (40, 20), (10, 40), (40, 40),
                                    (25, 30), (15, 25), (20, 45), (40, 20)]):
        number = 4 + 2 * index
        holdout = index >= 6
        rate = 60_000 * 1.7 * (a / 1000)**0.8 * (b / 1000)**-0.35
        rate *= math.exp(0.005 * (-1)**index)
        values = [45, rate, 'C' if holdout else ('A' if index % 2 else 'B'), 0.02,
                  'holdout' if holdout else 'train', a, b, 3]
        cells = []
        for col, value in zip(columns, values):
            address = f'{col}{number}'
            if isinstance(value, str):
                cells.append(f'<c r="{address}" t="inlineStr"><is><t>{value}</t></is></c>')
            else:
                cells.append(f'<c r="{address}"><v>{value}</v></c>')
        rows.append(f'<row r="{number}">{"".join(cells)}</row>')

    def relationships(*entries):
        body = ''.join(f'<Relationship Id="{key}" Type="{office}/{kind}" Target="{part}"/>'
                       for key, kind, part in entries)
        return f'<Relationships xmlns="{package}">{body}</Relationships>'

    workbook = f'<workbook xmlns="{main}" xmlns:r="{office}"><sheets>'
    workbook += '<sheet name="Notes" sheetId="1" r:id="rId3"/>'
    workbook += '<sheet name="Kinetic data" sheetId="2" r:id="rId7"/></sheets></workbook>'
    parts = {'xl/workbook.xml': (workbook, 'sheet.main'),
             'xl/worksheets/sheet1.xml': (f'<worksheet xmlns="{main}"><sheetData/></worksheet>', 'worksheet'),
             'xl/worksheets/observations.xml': (
                 f'<worksheet xmlns="{main}"><sheetData>{"".join(rows)}</sheetData></worksheet>', 'worksheet'),
             'xl/sharedStrings.xml': (f'<sst xmlns="{main}">{"".join(shared)}</sst>', 'sharedStrings')}
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w', zipfile.ZIP_DEFLATED) as archive:
        overrides = ''.join(f'<Override PartName="/{part}" ContentType="{content_type}.{kind}+xml"/>'
                            for part, (_, kind) in parts.items())
        archive.writestr('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                         '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                         f'{overrides}</Types>')
        archive.writestr('_rels/.rels', relationships(('rId1', 'officeDocument', 'xl/workbook.xml')))
        archive.writestr('xl/_rels/workbook.xml.rels', relationships(
            ('rId3', 'worksheet', 'worksheets/sheet1.xml'),
            ('rId2', 'sharedStrings', 'sharedStrings.xml'),
            ('rId7', 'worksheet', '/xl/worksheets/observations.xml')))
        for part, (xml, _) in parts.items():
            archive.writestr(part, xml)
    options = {'model': 'initial_rate_power_law', 'sheet': 'Kinetic data', 'temperature_unit': 'C',
               'response_unit': 'mmol/L/min', 'concentration_unit': 'mmol/L', 'conversion_unit': '%',
               'columns': dict(zip(('temperature', 'value', 'batch_id', 'relative_uncertainty',
                                    'partition'), headers[:5])) | {
                   'concentrations': {'A': 'A Loading', 'B': 'B Loading'}, 'conversion_fraction': 'Conversion'}}
    return 'power-law-demo.xlsx', stream.getvalue(), options


def _rewrite(content, change):
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive, zipfile.ZipFile(io.BytesIO(content)) as original:
        for name in original.namelist():
            archive.writestr(name, change(name, original.read(name)))
    return output.getvalue()


class KineticsImportTests(unittest.TestCase):
    def analyze(self, filename, content, options, origin='synthetic'):
        self.evidence = {}

        def register(name, blob):
            self.evidence[name] = json.loads(blob)
            return 'uncertainty-1'

        normalized, result, details = analyze(filename, content, options, origin, 'upload-1', register)
        validate_result(result, normalized)
        json.dumps((normalized, result, details), allow_nan=False)
        return normalized, result, details

    def test_arrhenius_and_holdout_exclusion(self):
        filename, blob, options = demo()
        normalized, result, details = self.analyze(filename, blob, options, 'research')
        self.assertEqual(normalized['source'], 'experimental')
        self.assertEqual(normalized['observations'][0]['temperature_K'], 308.15)
        self.assertEqual(normalized['observations'][0]['evidence_id'], 'upload-1')
        self.assertAlmostEqual(result['activation_energy'] / 52000, 1, delta=0.01)
        self.assertGreater(result['holdout_log_rmse'], 0)
        self.assertEqual(result['validation_scope'], 'independent_batch_mixed_conditions')
        self.assertEqual(details['rows'][-1]['row'], 8)
        self.assertEqual(result['parameter_uncertainty']['evidence_id'], 'uncertainty-1')
        self.assertEqual(len(self.evidence['kinetics-uncertainty.json']['training_observation_ids']), 5)
        _, train_only, _ = self.analyze(filename, b'\n'.join(blob.splitlines()[:-2]), options)
        self.assertEqual(result['activation_energy'], train_only['activation_energy'])
        self.assertEqual(result['prefactor'], train_only['prefactor'])
        self.assertIsNone(train_only['holdout_log_rmse'])

    def test_xlsx_power_law(self):
        normalized, result, details = self.analyze(*demo_xlsx())
        self.assertEqual(normalized['response_unit'], 'mol/L/s')
        self.assertEqual(normalized['observations'][0]['concentrations'], {'A': 0.01, 'B': 0.02})
        self.assertEqual(normalized['observations'][0]['conversion_fraction'], 0.03)
        self.assertAlmostEqual(result['orders']['A'], 0.8, delta=0.02)
        self.assertAlmostEqual(result['orders']['B'], -0.35, delta=0.02)
        self.assertAlmostEqual(result['rate_at_reference'], 1.7, delta=0.12)
        self.assertEqual(details['sheet'], 'Kinetic data')
        self.assertEqual(details['header_row'], 2)
        self.assertEqual(details['rows'][-1]['row'], 18)

    def test_measurement_uncertainty_and_explicit_single_batch(self):
        blob = b'Temperature,Response\n300,1\n320,2\n340,4\n360,7\n'
        options = {'batch_id': 'batch-17', 'temperature_unit': 'K',
                   'columns': {'temperature': 'Temperature', 'value': 'Response'}}
        normalized, result, details = self.analyze('routine.csv', blob, options)
        self.assertEqual({row['batch_id'] for row in normalized['observations']}, {'batch-17'})
        self.assertNotIn('relative_uncertainty', normalized['observations'][0])
        self.assertEqual(details['measurement_uncertainty']['status'], 'unavailable')
        self.assertFalse(details['rows'][0]['measurement_uncertainty_available'])
        self.assertEqual(result['parameter_uncertainty']['status'], 'reported')
        self.assertIn('single_training_batch', result['warnings'])
        for key in ('batch_id', 'temperature_unit'):
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, key):
                self.analyze('routine.csv', blob, {k: v for k, v in options.items() if k != key})
        split = b'Temperature,Response,partition\n300,1,train\n320,2,train\n340,4,holdout\n'
        with self.assertRaisesRegex(ValueError, 'independent batch IDs'):
            self.analyze('routine.csv', split, options)

    def test_partial_measurement_uncertainty_and_no_parameter_dof(self):
        blob = b'temperature_K,k,batch_id,relative_uncertainty\n300,1,A,0.03\n320,2,A,\n'
        normalized, result, details = self.analyze('routine.csv', blob, {})
        self.assertEqual(normalized['observations'][0]['relative_uncertainty'], 0.03)
        self.assertNotIn('relative_uncertainty', normalized['observations'][1])
        self.assertEqual(details['measurement_uncertainty']['status'], 'partial')
        self.assertEqual(result['parameter_uncertainty']['status'], 'unavailable')
        self.assertIn('no_condition_residual_dof', result['warnings'])

    def test_student_critical_values(self):
        for dof, critical in ((1, 12.706205), (2, 4.302653), (3, 3.182446), (30, 2.042272)):
            self.assertAlmostEqual(_student_95(dof), critical, places=5)

    def test_fit_quality_gates(self):
        filename, blob, options = demo()
        for field, pattern in [('max_train_log_rmse', 'train log RMSE'),
                               ('max_holdout_log_rmse', 'holdout log RMSE')]:
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, pattern):
                limits = {'max_train_log_rmse': 0.2, 'max_holdout_log_rmse': 0.3, field: 1e-6}
                self.analyze(filename, blob, options | {'acceptance': limits})
        self.assertFalse(self.evidence)

    def test_rank_deficient_training(self):
        filename, blob, options = demo()
        header, *rows = blob.splitlines()
        collapsed = b'\n'.join([header, *(b'50,' + row.split(b',', 1)[1] for row in rows)])
        with self.assertRaisesRegex(ValidationError, 'independent training conditions'):
            self.analyze(filename, collapsed, options)

    def test_rejects_formula_missing_and_bad_shared_index(self):
        filename, blob, options = demo_xlsx()
        mutations = [(b'<c r="A4"><v>45</v></c>', b'<c r="A4"><f>40+5</f><v>45</v></c>', 'formulas'),
                     (b'<c r="A4"><v>45</v></c>', b'', 'row 4.*missing'),
                     (b'<v>0</v>', b'<v>1000</v>', 'shared-string index')]
        for old, new, pattern in mutations:
            with self.subTest(pattern=pattern), self.assertRaisesRegex(ValueError, pattern):
                def change(name, data):
                    return data.replace(old, new, 1) if name.endswith('observations.xml') else data

                self.analyze(filename, _rewrite(blob, change), options)
        with self.assertRaisesRegex(ValueError, 'corrupt XLSX'):
            self.analyze(filename, blob[:-20], options)
        with self.assertRaisesRegex(ValueError, 'archive exceeds limits'):
            self.analyze(filename, _rewrite(blob, lambda name, data: (
                b' ' * (8 * 1024 * 1024 + 1) if name == '[Content_Types].xml' else data)), options)


if __name__ == '__main__':
    unittest.main()
