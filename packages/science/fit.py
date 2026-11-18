"""Import kinetic observations and estimate v1 model parameters."""

import json
import math
import re

import numpy as np

from . import kinetics
from .table import read_table


ARRHENIUS = 'arrhenius_known_k'
POWER_LAW = 'initial_rate_power_law'
ALIASES = {
    'temperature': ('temperature_K', 'temperature_C', 'temperature'),
    'value': ('value', 'response', 'k', 'rate'),
    'batch_id': ('batch_id', 'batch'),
    'condition_id': ('condition_id', 'condition'),
    'observation_id': ('observation_id',),
    'partition': ('partition',),
    'relative_uncertainty': ('relative_uncertainty',),
    'conversion_fraction': ('conversion_fraction', 'conversion'),
}
OPTIONS = {'model', 'sheet', 'columns', 'temperature_unit', 'response_unit', 'acceptance',
           'concentration_unit', 'conversion_unit', 'max_conversion_fraction', 'batch_id'}


def _number(value, label):
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        raise ValueError(f'{label} must be a finite number')
    if isinstance(value, str) and not re.fullmatch(
            r'[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[Ee][+-]?[0-9]+)?', value):
        raise ValueError(f'{label} must be a finite decimal number')
    try:
        result = float(value)
    except (ValueError, OverflowError) as error:
        raise ValueError(f'{label} must be a finite number') from error
    if not math.isfinite(result):
        raise ValueError(f'{label} must be a finite number')
    return result


def _response_unit(unit, power):
    units = ('mol/L/s', 'mol/(kg_cat*s)', 'mol/(m2_cat*s)') if power else (
        's^-1', 'mol/L/s', 'L/mol/s', 'L^2/mol^2/s')
    for canonical in units:
        for seconds, divisor in (('s', 1), ('min', 60), ('h', 3600)):
            spelling = canonical.replace('s', seconds)
            if unit == spelling:
                return canonical, 1 / divisor
            if spelling.startswith('mol/') and unit == 'm' + spelling:
                return canonical, 0.001 / divisor
    raise ValueError(f'Unsupported response_unit {unit!r} for this model')


def _mapping(headers, options, power):
    columns = options.get('columns', {})
    allowed = set(ALIASES) if power else set(ALIASES) - {'conversion_fraction'}
    if power:
        allowed.add('concentrations')
    if not isinstance(columns, dict) or columns.keys() - allowed:
        raise ValueError('columns must map supported logical fields to exact header names')
    required = {'temperature', 'value'}
    if power:
        required.add('conversion_fraction')
    mapped = {}
    for field, aliases in ALIASES.items():
        if field not in allowed:
            continue
        if field in columns:
            mapped[field] = columns[field]
            continue
        matches = [name for name in aliases if name in headers]
        if len(matches) > 1:
            raise ValueError(f'Ambiguous {field} headers {matches}; set columns.{field}')
        if matches:
            mapped[field] = matches[0]
        elif field in required:
            raise ValueError(f'Missing {field} column; set columns.{field} to a header in the file')

    concentrations = columns.get('concentrations', {})
    if power and (not isinstance(concentrations, dict) or not 1 <= len(concentrations) <= 32
                  or any(not isinstance(key, str) or not key.strip() for key in concentrations)):
        raise ValueError('Set columns.concentrations to a mapping of 1 to 32 reactants to headers')
    names = [*mapped.values(), *concentrations.values()]
    for name in names:
        if not isinstance(name, str) or name not in headers:
            raise ValueError(f'Mapped column {name!r} is absent from the header row')
    if len(names) != len(set(names)):
        raise ValueError('Each mapped field must use a distinct column')
    return mapped, concentrations


def _normalize(filename, content, options, origin, raw_id):
    if origin not in ('research', 'synthetic'):
        raise ValueError('origin must be research or synthetic')
    if not isinstance(options, dict) or options.keys() - OPTIONS:
        raise ValueError('Unknown kinetics options or options is not an object')
    model = options.get('model', ARRHENIUS)
    if model not in (ARRHENIUS, POWER_LAW):
        raise ValueError(f'Unknown kinetics model {model!r}')
    power = model == POWER_LAW
    if not power and options.keys() & {'concentration_unit', 'conversion_unit', 'max_conversion_fraction'}:
        raise ValueError('Concentration and conversion options apply only to the power-law model')
    requested_sheet = options.get('sheet')
    if requested_sheet is not None and (not isinstance(requested_sheet, str) or not requested_sheet.strip()):
        raise ValueError('sheet must be an exact XLSX tab name')
    sheet, table = read_table(filename, content, requested_sheet)
    if len(table) < 2:
        raise ValueError('The table needs a header and at least one data row')
    header_number, cells = table[0]
    headers = {name: index for index, name in cells.items()}
    if len(headers) != len(cells):
        raise ValueError(f'Row {header_number}: column headers must be unique')
    mapped, concentrations = _mapping(headers, options, power)
    batch_default = options.get('batch_id')
    if 'batch_id' in options and (not isinstance(batch_default, str) or not batch_default.strip()
                                  or 'batch_id' in mapped):
        raise ValueError('Set batch_id to one nonblank batch name only when no batch column is mapped')
    if 'batch_id' not in mapped and batch_default is None:
        raise ValueError('Map columns.batch_id or designate one batch using options.batch_id')
    inferred_unit = {'temperature_C': 'C', 'temperature_K': 'K'}.get(mapped['temperature'])
    temperature_unit = options.get('temperature_unit', inferred_unit)
    if temperature_unit not in ('C', 'K'):
        raise ValueError('Set temperature_unit to K or C for a column without a temperature_K or temperature_C header')
    if inferred_unit is not None and temperature_unit != inferred_unit:
        raise ValueError('temperature_unit disagrees with the temperature column header')
    response_input_unit = options.get('response_unit', 'mol/L/s' if power else 's^-1')
    unit, factor = _response_unit(response_input_unit, power)
    concentration_unit = options.get('concentration_unit', 'mol/L')
    conversion_unit = options.get('conversion_unit', 'fraction')
    if concentration_unit not in ('mol/L', 'mmol/L') or conversion_unit not in ('fraction', '%'):
        raise ValueError('Use concentration_unit mol/L or mmol/L and conversion_unit fraction or %')
    max_conversion = _number(options.get('max_conversion_fraction', 0.1), 'max_conversion_fraction')
    if not 0 < max_conversion <= 0.1:
        raise ValueError('max_conversion_fraction must be greater than zero and at most 0.1')
    limits = options.get('acceptance', {'max_train_log_rmse': 0.2, 'max_holdout_log_rmse': 0.3})
    train_limit, holdout_limit = 'max_train_log_rmse', 'max_holdout_log_rmse'
    if not isinstance(limits, dict) or train_limit not in limits or limits.keys() - {train_limit, holdout_limit}:
        raise ValueError('acceptance needs max_train_log_rmse and may include max_holdout_log_rmse')
    limits = {key: _number(value, key) for key, value in limits.items()}
    if min(limits.values()) <= 0:
        raise ValueError('Log RMSE limits must be positive')

    rows, references = [], []
    conditions, observation_ids = {}, set()
    missing_uncertainty = 0
    for number, cells in table[1:]:
        location = f'Sheet {sheet!r}, row {number}' if sheet is not None else f'CSV row {number}'

        def read(header):
            value = cells.get(headers[header])
            if value is None:
                raise ValueError(f'{location}: missing value in column {header!r}')
            return value

        def field(key, default):
            return read(mapped[key]) if key in mapped else default

        def numeric(header, factor=1, offset=0, minimum=0, inclusive=False):
            value = _number(read(header), f'{location}, column {header!r}') * factor + offset
            if not math.isfinite(value) or value < minimum or (value == minimum and not inclusive):
                raise ValueError(f'{location}: out-of-range value in column {header!r} after unit conversion')
            return value

        temperature = numeric(mapped['temperature'], offset=273.15 if temperature_unit == 'C' else 0)
        row = {
            'observation_id': field('observation_id', f'row-{number}'), 'evidence_id': raw_id,
            'batch_id': field('batch_id', batch_default), 'partition': field('partition', 'train').lower(),
            'temperature_K': temperature, 'value': numeric(mapped['value'], factor),
            'quality': 'accepted',
        }
        uncertainty_column = mapped.get('relative_uncertainty')
        has_uncertainty = uncertainty_column is not None and headers[uncertainty_column] in cells
        if has_uncertainty:
            row['relative_uncertainty'] = numeric(uncertainty_column)
        else:
            missing_uncertainty += 1
        if row['observation_id'] in observation_ids:
            raise ValueError(f'{location}: duplicate observation ID {row["observation_id"]!r}')
        observation_ids.add(row['observation_id'])
        if row['partition'] not in ('train', 'holdout'):
            raise ValueError(f'{location}: partition must be train or holdout')
        if batch_default is not None and row['partition'] == 'holdout':
            raise ValueError(f'{location}: holdout requires a batch column with independent batch IDs')
        if power:
            row['concentrations'] = {key: numeric(header, 0.001 if concentration_unit == 'mmol/L' else 1)
                                     for key, header in concentrations.items()}
            row['conversion_fraction'] = numeric(mapped['conversion_fraction'],
                                                 0.01 if conversion_unit == '%' else 1, inclusive=True)
            if row['conversion_fraction'] > max_conversion:
                raise ValueError(f'{location}: observation exceeds the initial-rate conversion limit')
            if rows and temperature != rows[0]['temperature_K']:
                raise ValueError(f'{location}: initial-rate power law requires a fixed temperature')
        settings = (temperature, *row.get('concentrations', {}).values())
        if 'condition_id' in mapped:
            row['condition_id'] = read(mapped['condition_id'])
        else:
            row['condition_id'] = conditions.setdefault(settings, f'condition-{len(conditions) + 1}')
        references.append({'row': number, 'measurement_uncertainty_available': has_uncertainty,
                           **{key: row[key] for key in (
            'observation_id', 'batch_id', 'condition_id', 'partition')}})
        rows.append(row)

    normalized = {'source': 'experimental' if origin == 'research' else origin,
                  'model': model, 'response_unit': unit, 'acceptance': limits, 'observations': rows}
    if power:
        normalized.update(concentration_unit='mol/L', temperature_K=rows[0]['temperature_K'],
                          reactants=list(concentrations), max_conversion_fraction=max_conversion)
    details = {'origin': origin, 'raw_id': raw_id, 'filename': filename, 'sheet': sheet,
               'header_row': header_number, 'rows': references,
               'columns': {**mapped, **({'concentrations': concentrations} if power else {})},
               'measurement_uncertainty': {'status': 'available' if not missing_uncertainty else
                                           'unavailable' if missing_uncertainty == len(rows) else 'partial',
                                           'available_rows': len(rows) - missing_uncertainty,
                                           'unavailable_rows': missing_uncertainty},
               'units': {'temperature': temperature_unit, 'response': response_input_unit}}
    if power:
        details['units'].update(concentration=concentration_unit, conversion=conversion_unit)
    return normalized, details


def _parameters(model, reactants, coefficients):
    scale = math.exp(float(coefficients[0]))
    if model == ARRHENIUS:
        return {'prefactor': scale,
                'activation_energy': float(-coefficients[1] * kinetics.GAS_CONSTANT_J_PER_MOL_K)}
    return {'rate_at_reference': scale, **{f'order:{key}': float(value)
                                         for key, value in zip(reactants, coefficients[1:])}}


def _student_95(dof):
    # Under t = sqrt(dof) * tan(theta), the density is proportional to
    # cos(theta)**(dof - 1). Integrate that power by reduction and bisect.
    exponent = dof - 1

    def integral(angle, sine, cosine):
        parity = exponent % 2
        value = sine if parity else angle
        power = cosine if not parity else cosine * cosine
        for order in range(2 + parity, exponent + 1, 2):
            value = (sine * power + (order - 1) * value) / order
            power *= cosine * cosine
        return value

    target = 0.95 * integral(math.pi / 2, 1, 0)
    lower, upper = 0, math.pi / 2
    for _ in range(45):
        angle = (lower + upper) / 2
        if integral(angle, math.sin(angle), math.cos(angle)) < target:
            lower = angle
        else:
            upper = angle
    return math.sqrt(dof) * math.tan((lower + upper) / 2)


def _intervals(model, reactants, transform, design, errors, coefficients, parameters):
    # SVD avoids forming the normal equations, which square the condition number.
    _, singular, vectors = np.linalg.svd(design, full_matrices=False)
    directions = (transform @ vectors.T) / singular
    dof = len(errors) - len(coefficients)
    sigma = np.linalg.norm(errors) / math.sqrt(dof)
    delta = _student_95(dof) * sigma * np.linalg.norm(directions, axis=1)
    try:
        left = _parameters(model, reactants, coefficients - delta)
        right = _parameters(model, reactants, coefficients + delta)
    except OverflowError:
        return None
    result = {}
    for key, value in parameters.items():
        lower, upper = sorted((left[key], right[key]))
        if not (math.isfinite(lower) and math.isfinite(upper) and lower < upper
                and (key not in {'prefactor', 'rate_at_reference'} or lower > 0)
                and lower <= value <= upper):
            return None
        result[key] = {'lower': lower, 'upper': upper}
    return result


def _fit(normalized):
    rank, scope, warnings = kinetics._validate_design(normalized)
    model, unit, rows = (normalized[key] for key in ('model', 'response_unit', 'observations'))
    reactants = normalized.get('reactants', [])
    x = np.array([kinetics._features(normalized, row) for row in rows])
    y = np.array([math.log(row['value']) for row in rows])
    train = np.array([row['partition'] == 'train' for row in rows])
    x_train = x[train]
    magnitude = np.abs(x_train).max(axis=0)
    scaled = x_train / magnitude
    center = scaled.mean(axis=0)
    spread = np.linalg.norm(scaled - center, axis=0) / math.sqrt(int(train.sum()))
    design = np.column_stack((np.ones(train.sum()), (scaled - center) / spread))
    try:
        beta, _, actual_rank, singular = np.linalg.lstsq(design, y[train], rcond=1e-10)
    except np.linalg.LinAlgError as error:
        raise ValueError('Training least squares did not converge') from error
    if actual_rank != rank:
        raise ValueError('Training design is numerically rank deficient; vary predictors independently')
    physical_spread = spread * magnitude
    if np.any(physical_spread < 1 / np.finfo(float).max):
        raise ValueError('Training predictor spread is too small for representable kinetic parameters')
    transform = np.diag(np.r_[1, 1 / physical_spread])
    transform[0, 1:] = -center / spread
    coefficients = transform @ beta
    try:
        parameters = _parameters(model, reactants, coefficients)
    except OverflowError as error:
        raise ValueError('Fitted kinetic parameters exceed the representable range') from error
    scale_key = 'prefactor' if model == ARRHENIUS else 'rate_at_reference'
    if not parameters[scale_key] or not all(map(math.isfinite, parameters.values())):
        raise ValueError('Fitted kinetic parameters exceed the representable range')
    if model == ARRHENIUS:
        slopes = [-parameters['activation_energy'] / kinetics.GAS_CONSTANT_J_PER_MOL_K]
        fields = {**parameters, 'prefactor_unit': unit, 'activation_energy_unit': 'J/mol'}
    else:
        slopes = [parameters[f'order:{key}'] for key in reactants]
        fields = {'reference_concentration_mol_L': 1, 'rate_at_reference': parameters[scale_key],
                  'rate_at_reference_unit': unit, 'orders': dict(zip(reactants, slopes))}
    intercept = math.log(parameters[scale_key])
    try:
        errors = np.array([math.fsum([intercept, *(a * float(b) for a, b in zip(slopes, values)),
                                    -observed]) for values, observed in zip(x, y)])
    except (ValueError, OverflowError) as error:
        raise ValueError('Kinetic prediction exceeded the representable range') from error
    result = {'source': normalized['source'], 'model': model, **fields, 'design_rank': rank,
              'validation_scope': scope, 'warnings': sorted(warnings),
              'residuals': [{'observation_id': row['observation_id'], 'log_residual': float(error)}
                            for row, error in zip(rows, errors)]}
    failures = []
    for partition, mask in (('train', train), ('holdout', ~train)):
        field = f'{partition}_log_rmse'
        count = int(mask.sum())
        rmse = math.hypot(*(errors[mask] / math.sqrt(count))) if count else None
        result[field] = rmse
        if rmse is not None and rmse > (limit := normalized['acceptance'][f'max_{field}']):
            failures.append(f'{partition} log RMSE {rmse:.6g} exceeds limit {limit:.6g}')
    if failures:
        raise ValueError('Kinetics fit failed acceptance: ' + '; '.join(failures))

    intervals = None
    fit_errors = design @ beta - y[train]
    roundoff = 32 * np.finfo(float).eps * max(1, np.abs(y[train]).max())
    if 'no_condition_residual_dof' not in warnings and np.abs(fit_errors).max() > roundoff:
        intervals = _intervals(model, reactants, transform, design, fit_errors, coefficients, parameters)
    uncertainty = {'status': 'unavailable', 'reason': (
        'Too few distinct training conditions for residual degrees of freedom'
        if 'no_condition_residual_dof' in warnings else
        'Training residual variance is indistinguishable from roundoff or interval width is not representable')}
    result['parameter_uncertainty'] = uncertainty
    diagnostics = {'train_rows': int(train.sum()), 'holdout_rows': int((~train).sum()),
                   'design_rank': rank, 'scaled_condition_number': float(singular[0] / singular[-1]),
                   'train_log_rmse': result['train_log_rmse'], 'holdout_log_rmse': result['holdout_log_rmse'],
                   'validation_scope': scope, 'warnings': result['warnings'], 'status': 'passed'}
    return result, diagnostics, intervals


def analyze(filename: str, content: bytes, options: dict, origin: str, raw_id: str,
            register: callable) -> tuple[dict, dict, dict]:
    normalized, details = _normalize(filename, content, options, origin, raw_id)
    result, diagnostics, intervals = _fit(normalized)
    details['fit_diagnostics'] = diagnostics
    if intervals is not None:
        method = 'Unweighted log-space OLS covariance with independent homoscedastic Gaussian errors and Student t intervals'
        uncertainty = {'status': 'reported', 'method': method, 'confidence_level': 0.95,
                       'intervals': intervals, 'evidence_id': raw_id}
        result['parameter_uncertainty'] = uncertainty
        kinetics.validate_result(result, normalized)
        evidence = {'raw_id': raw_id, 'training_observation_ids': [row['observation_id']
                    for row in normalized['observations'] if row['partition'] == 'train'],
                    'method': method, 'confidence_level': 0.95, 'intervals': intervals}
        uncertainty['evidence_id'] = register('kinetics-uncertainty.json',
                                              json.dumps(evidence, allow_nan=False).encode('utf-8'))
    kinetics.validate_result(result, normalized)
    return normalized, result, details
