'use client'

import { useState } from 'react'

type Template = {
  icon: string
  label: string
  category: string
  query: string
}

const TEMPLATES: Template[] = [
  // Patient Flow
  { icon: '🏥', label: 'Patient Census', category: 'Patient Flow',
    query: 'Show me current patient count by unit and department' },
  { icon: '📥', label: 'Daily Admissions', category: 'Patient Flow',
    query: 'How many patients were admitted each day this month?' },
  { icon: '📤', label: 'Discharges Today', category: 'Patient Flow',
    query: 'Show me all patient discharges today by unit' },
  { icon: '🔄', label: 'Readmissions', category: 'Patient Flow',
    query: 'Show readmission rates by department in the last 3 months' },

  // Clinical Outcomes
  { icon: '⏱️', label: 'Length of Stay', category: 'Clinical Outcomes',
    query: 'What is the average length of stay by unit in the last 30 days?' },
  { icon: '💊', label: 'Top Diagnoses', category: 'Clinical Outcomes',
    query: 'What are the top 10 diagnosis codes by patient count this month?' },
  { icon: '❤️', label: 'Vital Signs', category: 'Clinical Outcomes',
    query: 'Show average heart rate and oxygen saturation by unit this week' },

  // Resource Utilization
  { icon: '🛏️', label: 'ICU Occupancy', category: 'Resource Utilization',
    query: 'What is ICU bed occupancy this week vs last week?' },
  { icon: '👨‍⚕️', label: 'Doctor Workload', category: 'Resource Utilization',
    query: 'Show patient count per doctor in the last 30 days' },

  // Quality Metrics
  { icon: '📈', label: 'Monthly Trends', category: 'Quality Metrics',
    query: 'Show monthly patient admission trends for the last 12 months' },
  { icon: '🏆', label: 'Dept Performance', category: 'Quality Metrics',
    query: 'Compare average length of stay across all departments this quarter' },
]

const ALL_CATEGORIES = ['All', 'Patient Flow', 'Clinical Outcomes', 'Resource Utilization', 'Quality Metrics'] as const
type CategoryFilter = typeof ALL_CATEGORIES[number]

type Props = {
  onSelect: (query: string) => void
}

export function QueryTemplates({ onSelect }: Props) {
  const [activeCategory, setActiveCategory] = useState<CategoryFilter>('All')

  const filtered = activeCategory === 'All'
    ? TEMPLATES
    : TEMPLATES.filter((t) => t.category === activeCategory)

  return (
    <div className="bg-[#111114] border-b border-[#1f1f25] px-4 py-2.5 flex-shrink-0">
      {/* Category filter pills */}
      <div className="flex gap-1.5 mb-2 overflow-x-auto scrollbar-hide">
        {ALL_CATEGORIES.map((cat) => (
          <button
            key={cat}
            onClick={() => setActiveCategory(cat)}
            className={`px-2.5 py-1 rounded-full text-[10px] font-medium whitespace-nowrap flex-shrink-0 border transition-all ${
              activeCategory === cat
                ? 'bg-[#7c68ff20] text-[#7c68ff] border-[#7c68ff40]'
                : 'text-[#44444b] border-transparent hover:text-[#6c6c74]'
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      {/* Template chips */}
      <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
        {filtered.map((t) => (
          <button
            key={t.label}
            onClick={() => onSelect(t.query)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[#16161a] border border-[#2a2a31] text-[11px] text-[#a0a0a7] whitespace-nowrap hover:border-[#7c68ff60] hover:text-[#e8e8ea] hover:bg-[#7c68ff10] cursor-pointer transition-all flex-shrink-0"
          >
            <span>{t.icon}</span>
            <span className="font-medium">{t.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
