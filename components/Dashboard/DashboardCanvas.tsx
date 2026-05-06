'use client'

import { LayoutGrid } from 'lucide-react'
import { DashboardWidget } from './DashboardWidget'
import type { CanvasWidget, WidgetSize } from '@/lib/dashboardStore'

type Props = {
  widgets: CanvasWidget[]
  editMode: boolean
  onRemove: (id: string) => void
  onMove: (id: string, direction: 'up' | 'down' | 'left' | 'right') => void
  onSizeChange: (id: string, size: WidgetSize) => void
}

export function DashboardCanvas({ widgets, editMode, onRemove, onMove, onSizeChange }: Props) {
  if (widgets.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center p-8">
        <div className="w-16 h-16 rounded-2xl bg-[#16161a] border border-[#2a2a31] flex items-center justify-center">
          <LayoutGrid size={24} className="text-[#2a2a31]" />
        </div>
        <p className="text-[15px] font-semibold text-[#3a3a45]">Add charts from the panel to get started</p>
        <p className="text-[12px] text-[#2a2a31] max-w-[260px]">
          Click the + button next to any chart in the left panel to place it on the canvas.
        </p>
      </div>
    )
  }

  const sorted = [...widgets].sort((a, b) => a.order - b.order)

  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {sorted.map((widget, idx) => (
          <DashboardWidget
            key={widget.id}
            widget={widget}
            editMode={editMode}
            isFirst={idx === 0}
            isLast={idx === sorted.length - 1}
            onRemove={() => onRemove(widget.id)}
            onMoveUp={() => onMove(widget.id, 'up')}
            onMoveDown={() => onMove(widget.id, 'down')}
            onMoveLeft={() => onMove(widget.id, 'left')}
            onMoveRight={() => onMove(widget.id, 'right')}
            onSizeChange={(size) => onSizeChange(widget.id, size)}
          />
        ))}
      </div>
    </div>
  )
}
