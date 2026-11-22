export const RANGES = [
  { label: '24 h', hours: 24 },
  { label: '7 days', hours: 24 * 7 },
  { label: '30 days', hours: 24 * 30 },
]

export function RangePicker({ hours, onChange }: { hours: number; onChange: (hours: number) => void }) {
  return (
    <div className="chips" role="group" aria-label="Time range">
      {RANGES.map((r) => (
        <button key={r.hours} className={hours === r.hours ? 'chip active' : 'chip'} onClick={() => onChange(r.hours)}>
          {r.label}
        </button>
      ))}
    </div>
  )
}
