import { Download, Table2 } from "lucide-react";
import { useMemo } from "react";

import type {
  BackendCreditDashboardBreakdownRow,
  BackendCreditDashboardBucket,
  BackendCreditDashboardGranularity,
} from "../../services/backendApi";
import {
  breakdownColor,
  bucketTotals,
  exportPivotCsv,
  formatCredits,
  formatPercent,
  formatUsd,
  granularityLabels,
  isOtherRow,
  maxPivotCell,
  pivotCellTint,
  pivotDimensionLabels,
  type PivotDimension,
} from "../../features/credits/creditUsageDashboardUtils";

export type PivotCell = { dimension: PivotDimension; rowId: string; rowLabel: string; bucketKey: string };

const granularities: BackendCreditDashboardGranularity[] = ["day", "week", "month"];
const dimensions: PivotDimension[] = ["model", "project", "user"];

export function CreditSpendPivot({
  buckets,
  rows,
  dimension,
  granularity,
  selectedCell,
  onDimensionChange,
  onGranularityChange,
  onSelectCell,
}: {
  buckets: BackendCreditDashboardBucket[];
  rows: BackendCreditDashboardBreakdownRow[];
  dimension: PivotDimension;
  granularity: BackendCreditDashboardGranularity;
  selectedCell: PivotCell | null;
  onDimensionChange: (next: PivotDimension) => void;
  onGranularityChange: (next: BackendCreditDashboardGranularity) => void;
  onSelectCell: (cell: PivotCell | null) => void;
}) {
  const maxCell = useMemo(() => maxPivotCell(rows), [rows]);
  const totals = useMemo(() => bucketTotals(buckets), [buckets]);

  return (
    <section className="rounded-lg border border-line bg-white p-3 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-stone-500">
            <Table2 className="h-3.5 w-3.5" />
            Spend breakdown
          </div>
          <SegmentedControl
            label="Bucket"
            options={granularities.map((value) => ({ value, label: granularityLabels[value] }))}
            value={granularity}
            onChange={onGranularityChange}
          />
          <SegmentedControl
            label="Group by"
            options={dimensions.map((value) => ({ value, label: pivotDimensionLabels[value] }))}
            value={dimension}
            onChange={onDimensionChange}
          />
        </div>
        <button
          type="button"
          onClick={() => exportPivotCsv(buckets, rows, dimension)}
          disabled={!rows.length}
          className="flex h-9 items-center gap-1 rounded-md border border-line bg-white px-2 text-xs font-bold text-stone-600 transition hover:border-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Download className="h-3.5 w-3.5" />
          CSV
        </button>
      </div>

      {rows.length ? (
        <>
          <div className="overflow-x-auto rounded-md border border-line">
            <table className="w-full min-w-[720px] border-collapse text-left text-xs">
              <thead className="bg-mist text-stone-600">
                <tr>
                  <th scope="col" className="sticky left-0 z-10 bg-mist px-2 py-2 font-bold">
                    {pivotDimensionLabels[dimension]}
                  </th>
                  {buckets.map((bucket) => (
                    <th key={bucket.key} scope="col" className="whitespace-nowrap px-2 py-2 text-right font-bold">
                      {bucket.label}
                    </th>
                  ))}
                  <th scope="col" className="px-2 py-2 text-right font-bold">
                    Total
                  </th>
                  <th scope="col" className="min-w-32 px-2 py-2 font-bold">
                    Share
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((row, rowIndex) => (
                  <tr key={row.id} className="bg-white">
                    <th
                      scope="row"
                      className="sticky left-0 z-10 max-w-48 truncate bg-white px-2 py-2 text-left font-bold text-ink"
                      title={row.label}
                    >
                      {row.label}
                    </th>
                    {buckets.map((bucket, bucketIndex) => {
                      const credits = row.perBucket[bucketIndex] ?? 0;
                      const selected =
                        selectedCell?.rowId === row.id &&
                        selectedCell.bucketKey === bucket.key &&
                        selectedCell.dimension === dimension;
                      return (
                        <PivotCellButton
                          key={bucket.key}
                          credits={credits}
                          tint={pivotCellTint(credits, maxCell)}
                          selected={selected}
                          selectable={!isOtherRow(row)}
                          label={`${row.label}, ${bucket.label}: ${formatCredits(credits)} credits`}
                          onClick={() =>
                            onSelectCell(
                              selected
                                ? null
                                : { dimension, rowId: row.id, rowLabel: row.label, bucketKey: bucket.key },
                            )
                          }
                        />
                      );
                    })}
                    <td className="px-2 py-2 text-right font-bold text-ink">{formatCredits(row.credits)}</td>
                    <td className="px-2 py-2">
                      <div className="flex items-center gap-2">
                        <span className="h-1.5 min-w-16 flex-1 overflow-hidden rounded-full bg-stone-100">
                          <span
                            className="block h-full rounded-full"
                            style={{
                              width: `${Math.max(2, Math.min(100, row.percentage))}%`,
                              backgroundColor: breakdownColor(row, rowIndex),
                            }}
                          />
                        </span>
                        <span className="w-10 shrink-0 text-right text-stone-500">{formatPercent(row.percentage)}</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-mist/70 font-bold text-ink">
                  <th scope="row" className="sticky left-0 z-10 bg-mist/70 px-2 py-2 text-left">
                    Total
                  </th>
                  {buckets.map((bucket) => (
                    <td key={bucket.key} className="whitespace-nowrap px-2 py-2 text-right">
                      {formatCredits(bucket.credits)}
                    </td>
                  ))}
                  <td className="px-2 py-2 text-right">{formatCredits(totals.credits)}</td>
                  <td className="px-2 py-2 font-semibold text-stone-500">{formatUsd(totals.usd)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="mt-2 text-xs font-semibold text-stone-500">
            Cell shading scales with spend. Click a cell to filter the events below to that {pivotDimensionLabels[
              dimension
            ].toLowerCase()} and {granularityLabels[granularity].toLowerCase()}.
          </p>
        </>
      ) : (
        <p className="text-sm font-semibold text-stone-500">No credit usage in this range.</p>
      )}
    </section>
  );
}

function PivotCellButton({
  credits,
  tint,
  selected,
  selectable,
  label,
  onClick,
}: {
  credits: number;
  tint: number;
  selected: boolean;
  selectable: boolean;
  label: string;
  onClick: () => void;
}) {
  if (credits <= 0) {
    return (
      <td className="px-2 py-2 text-right text-stone-300" aria-label={label}>
        -
      </td>
    );
  }
  // The collapsed "Other" row aggregates entities the payload no longer names,
  // so there is nothing to filter the events table down to.
  if (!selectable) {
    return (
      <td className="px-2 py-2 text-right text-ink" style={{ backgroundColor: `rgba(148, 163, 184, ${tint * 0.32})` }}>
        {formatCredits(credits)}
      </td>
    );
  }
  return (
    <td className="p-0">
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        aria-pressed={selected}
        // The tint is the value channel here, so the selected state is an inset
        // ring rather than a background swap that would erase it.
        className={`h-full w-full px-2 py-2 text-right transition ${
          selected ? "font-bold text-ink ring-2 ring-inset ring-accent" : "text-ink hover:ring-1 hover:ring-inset hover:ring-accent/50"
        }`}
        style={{ backgroundColor: `rgba(20, 184, 166, ${tint * 0.32})` }}
      >
        {formatCredits(credits)}
      </button>
    </td>
  );
}

function SegmentedControl<Value extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ value: Value; label: string }>;
  value: Value;
  onChange: (next: Value) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-semibold text-stone-500">{label}</span>
      <div className="flex overflow-hidden rounded-md border border-line" role="group" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            aria-pressed={value === option.value}
            className={`px-2.5 py-1.5 text-xs font-bold transition ${
              value === option.value ? "bg-accent text-white" : "bg-white text-stone-600 hover:bg-mist/70"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
