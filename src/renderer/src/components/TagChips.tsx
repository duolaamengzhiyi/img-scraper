import { memo } from 'react'
import { cn } from '@/lib/utils'

export interface TagChip {
  name: string
  count?: number
}

interface TagChipsProps {
  tags: TagChip[]
  selected: Set<string>
  onToggle: (name: string) => void
  onClear: () => void
  allLabel?: string
  allCount?: number
}

/** 顶部标签多选 chips：点击切换，「全部」清空选择（memo：props 稳定时跳过重渲染） */
export const TagChips = memo(function TagChips({
  tags,
  selected,
  onToggle,
  onClear,
  allLabel = '全部',
  allCount
}: TagChipsProps): React.JSX.Element {
  const chip = (active: boolean): string =>
    cn(
      'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors',
      active
        ? 'border-transparent bg-primary text-primary-foreground'
        : 'border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground'
    )

  return (
    <div className="flex max-h-32 flex-wrap gap-2 overflow-y-auto">
      <button type="button" onClick={onClear} className={chip(selected.size === 0)}>
        {allLabel}
        {allCount !== undefined && <span className="opacity-70">{allCount}</span>}
      </button>
      {tags.map((t) => (
        <button
          type="button"
          key={t.name}
          onClick={() => onToggle(t.name)}
          className={chip(selected.has(t.name))}
        >
          {t.name}
          {t.count !== undefined && <span className="opacity-70">{t.count}</span>}
        </button>
      ))}
    </div>
  )
})
