# Kinetics spreadsheet import

## 操作速查

在工作台展开「科学分析与晶胞工具」，将「分析类型」设为「动力学拟合」。上传实测文件时，将「数据来源」选为「研究数据」。表格第一条非空行应为表头。

1. **CSV · Arrhenius**。上传 UTF-8 逗号分隔文件，选择「Arrhenius（已测速率常数）」。表头为 `temperature_K,k,batch_id` 时，列名可留空自动匹配，温度按 K 读取，一级速率常数的响应单位选 `s^-1`。如果实际表头是 `反应温度,速率常数,实验批号`，就把「温度列」「响应列」「批次列」分别填成这三个表头，并按原表单位明确选择 K 或 °C。XLSX 工作表名称留空。
2. **XLSX · 初始速率幂律**。选择「初始速率幂律」，在「工作表名称」填实际标签名，例如 `动力学数据`。若表头是 `恒温槽温度,初始速率,实验批号,A浓度,B浓度,转化率`，则将温度、响应、批次、转化率分别映射到对应表头，在「反应物与浓度列」填 `{"A":"A浓度","B":"B浓度"}`。按原表选择单位，例如 °C、`mol/L/s`、`mmol/L` 和百分数，转化率填 `3` 即表示 3%。各行温度须相同，转化率默认上限为 10%。请上传粘贴为值后的工作表。
3. **批次和不确定度**。没有批次列时，在「单批次编号」填实际批次名，例如 `B01`，全部数据用于训练。需要独立留出验证时，提供真实批次列和 `partition` 列，或将「训练 / 留出列」映射到自定义表头。填 `train` 或 `holdout`，同一批次只用于其中一种。相对不确定度可用 `relative_uncertainty` 表头或映射自定义列，例如 `0.03` 表示 3%。缺测可留空，拟合参数的置信区间在可估计时单独报告。
4. **返回工作台**。指南在新标签页打开。切回原工作台标签页，点击「运行分析」，查看参数、训练及留出误差或失败提示。已保存的运行可从「运行历史」重新打开。

`packages.science.fit.analyze(filename, content, options, origin, raw_id, register)` accepts uploaded CSV or XLSX bytes. It returns `(normalized_input, result, details)`. The first two objects validate against the v1 kinetics contracts. `origin` is `research` or `synthetic`, and the resulting contract source is `experimental` or `synthetic` respectively. Every observation references `raw_id`, the evidence ID for the exact uploaded bytes. `details.rows` connects each observation, batch, condition, and partition to a physical source row. The filename, worksheet, header row, selected columns, and input units are recorded alongside it.

The adapter raises `ValueError` or `jsonschema.ValidationError` on rejected imports or fits. Acceptance errors include the measured partition RMSE and the limit. An unidentified or rejected model yields no successful fit result.

## Column mapping

The first nonblank row is the header. Headers and values are trimmed. Header matching is case-sensitive, and aliases that match multiple headers require an explicit mapping. Unmapped columns do not enter the fit. Set `columns` to map any logical field to its exact trimmed header.

| Logical field | Automatic headers | Requirement |
| --- | --- | --- |
| `temperature` | `temperature_K`, `temperature_C`, `temperature` | Required |
| `value` | `value`, `response`, `k`, `rate` | Required |
| `batch_id` | `batch_id`, `batch` | Required unless `options.batch_id` supplies one explicit batch for a file with no mapped batch column |
| `relative_uncertainty` | `relative_uncertainty` | Optional positive numeric fraction |
| `partition` | `partition` | Optional. Defaults to `train`. Allowed values are `train` and `holdout`, case-insensitive |
| `condition_id` | `condition_id`, `condition` | Optional. Equal normalized predictor settings share generated condition IDs when this column is absent |
| `observation_id` | `observation_id` | Optional. Defaults to `row-<physical row number>` |
| `conversion_fraction` | `conversion_fraction`, `conversion` | Required for the power law |
| `concentrations` | Explicit `columns.concentrations` object | Required for the power law. Maps one to 32 reactant names to their headers |

Batch and condition IDs are case-sensitive. A condition ID must refer to one predictor setting. Holdout batches must be disjoint from training batches. The `batch_id` option supports training-only imports. Independent holdout requires an explicit batch column and partition column.

Omitted or blank measurement uncertainty is omitted from the normalized observation. Values supplied as positive fractions are preserved. `details.measurement_uncertainty.status` is `available`, `partial`, or `unavailable`, with counts and a `measurement_uncertainty_available` flag per source row. Parameter confidence intervals are reported independently in `result.parameter_uncertainty`.

## Options and units

The model defaults to `arrhenius_known_k`. For XLSX, `sheet` selects an exact worksheet tab name and defaults to the first worksheet in workbook order. Omit `sheet` for CSV. `temperature_K` implies `K` and `temperature_C` implies `C`. All other temperature headers require an explicit `temperature_unit`. Celsius is converted with `K = C + 273.15` and absolute temperature must be positive.

| Model | Canonical `response_unit` values | Default |
| --- | --- | --- |
| `arrhenius_known_k` | `s^-1`, `mol/L/s`, `L/mol/s`, `L^2/mol^2/s` | `s^-1` |
| `initial_rate_power_law` | `mol/L/s`, `mol/(kg_cat*s)`, `mol/(m2_cat*s)` | `mol/L/s` |

For input response units, the supported seconds token `s` can be replaced with `min` or `h`. Response units beginning with `mol/` also accept `mmol/`. The adapter converts the time and amount scales to the corresponding v1 unit. Catalyst mass, surface area, and solution volume bases are carried through as declared. For the power law, `concentration_unit` supports `mol/L` (default) and `mmol/L`. `conversion_unit` supports `fraction` (default) and `%`. Conversion must be between zero and `max_conversion_fraction` inclusive. The limit defaults to `0.1` and may be lower. All rows must share the same normalized absolute temperature for the power law.

`acceptance` defaults to `{"max_train_log_rmse": 0.2, "max_holdout_log_rmse": 0.3}`. When overridden, specify a positive training limit and a positive holdout limit if the file includes holdout rows.

```json
{
  "model": "initial_rate_power_law",
  "sheet": "Kinetic data",
  "temperature_unit": "C",
  "response_unit": "mmol/L/min",
  "concentration_unit": "mmol/L",
  "conversion_unit": "%",
  "columns": {
    "temperature": "Bath Temp",
    "value": "Initial Rate",
    "batch_id": "Run Batch",
    "relative_uncertainty": "Relative SD",
    "partition": "Split",
    "conversion_fraction": "Conversion",
    "concentrations": {"A": "A Loading", "B": "B Loading"}
  }
}
```

## Fit and uncertainty

- Arrhenius fits `ln(k) = ln(A) - Ea/(R T)` for supplied rate constants and reports `Ea` in J/mol and `A` in the normalized response unit.
- The fixed-temperature power law fits `ln(rate) = ln(rate_ref) + sum(n_j ln(C_j / (1 mol/L)))`. It reports the reference rate and one order per reactant. Both models allow signed slopes.
- Both models use unweighted natural-log least squares with an intercept. Predictors are centered and scaled using training data only. NumPy solves the design with an SVD-based rank cutoff of `1e-10` relative to the largest singular value. The v1 design checks also require independent training settings and full rank. `details.fit_diagnostics` reports rank, the scaled condition number, partition sizes, RMSE, validation scope, and warnings.
- Residuals are `ln(predicted) - ln(observed)` in upload order. Train and holdout RMSE are computed separately from the fitted parameters. The validation scope indicates whether independent batches repeat training settings, contain new settings, or include both. The default training-only scope has a null holdout RMSE.
- When estimable, the adapter reports marginal 95% Student t confidence intervals from training-only ordinary least squares covariance, `s² = RSS/(n_train - p)`, under independent homoscedastic Gaussian errors in log space. The SVD yields covariance directions in the scaled design, which are transformed back to model coordinates. Interval endpoints for the log intercept are exponentiated, and the Arrhenius slope interval is converted to J/mol. These intervals use regression residual variance. They do not propagate measurement errors or adjust for within-batch dependence. Interval estimation requires more distinct training settings than parameters, residual variance above numerical roundoff, and finite, nondegenerate representable endpoints. When reported, `register('kinetics-uncertainty.json', bytes)` stores interval evidence and training observation IDs. The host uses the uploaded file as the registered blob's parent.

## Supported file limits and fixtures

CSV is comma-delimited UTF-8 with optional BOM and standard CSV quoting. XLSX is a bounded OOXML subset with relationship-selected worksheets, numeric cells, shared strings including rich text, inline strings, and sparse addresses. Blank rows and cells are allowed where data is optional. Formulas, error and unsupported cell types, merged cells on the selected tab, missing required mapped values, invalid relationships, and corrupt archives are rejected. Use pasted literal values for kinetic data. Imports do not evaluate cells or open external relationships. Hidden rows on the selected sheet are treated as ordinary rows.

Uploads are limited to 8 MiB, 25,000 physical row indices, 256 columns, and 500,000 cells. XLSX also permits at most 256 ZIP entries, 8 MiB per expanded entry, and 32 MiB expanded total. The archive accepts stored or deflated entries and checks CRCs. XML external entities, DTDs, and network access are disabled or rejected. NumPy and lxml versions are pinned in `requirements.lock`.

`tests/test_fit_import.py` exports `demo()` for an automatically mapped Arrhenius CSV and `demo_xlsx()` for a mapped two-reactant workbook. Each returns `(filename, bytes, options)` and includes an independent holdout batch.


## 自然语言工作台入口

服务启动时提供 `--mlcc-model-config /home/v100/mlcc-independent/config/worker.env`，方可启用已授权的 MLCC 模型调用。认证由独立模型进程读取，凭据不写入项目或日志；工作台进程的网络限制仍然生效。所选项目必须已有动力学实验表记录；在「自然语言动力学拟合」选择原始表，输入指令并提交。模型只接收指令、文件名、所选工作表及现有拟合模型，原始表由 V100 项目工具读取。结果界面可下载原表，项目内 `agent-requests/` 保存指令、模型调用和来源关联。模型调用属于用户已授权的公网出口例外。
