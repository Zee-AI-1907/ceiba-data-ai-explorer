'use client'

/**
 * Lightweight SQL syntax highlighter — no external deps.
 * Produces HTML spans with MC design system colors.
 */

const KEYWORDS = new Set([
  'SELECT','FROM','WHERE','JOIN','ON','AS','GROUP','BY','ORDER','HAVING',
  'LIMIT','OFFSET','INSERT','INTO','VALUES','UPDATE','SET','DELETE',
  'INNER','LEFT','RIGHT','FULL','OUTER','CROSS','DISTINCT','ALL',
  'AND','OR','NOT','IN','LIKE','BETWEEN','IS','NULL','TRUE','FALSE',
  'WITH','UNION','EXCEPT','INTERSECT','CASE','WHEN','THEN','ELSE','END',
  'CREATE','DROP','ALTER','TABLE','VIEW','INDEX','PRIMARY','KEY',
  'REFERENCES','FOREIGN','CONSTRAINT','DEFAULT','UNIQUE',
  'INTERVAL','YEAR','MONTH','DAY','HOUR','MINUTE','SECOND',
])

const FUNCTIONS = new Set([
  'TO_CHAR','COUNT','SUM','AVG','MIN','MAX','COALESCE','NULLIF','CAST',
  'DATE_TRUNC','DATE_PART','EXTRACT','NOW','CURRENT_DATE','CURRENT_TIMESTAMP',
  'CONCAT','TRIM','UPPER','LOWER','LENGTH','SUBSTR','SUBSTRING',
  'ROW_NUMBER','RANK','DENSE_RANK','LAG','LEAD','FIRST_VALUE','LAST_VALUE',
  'ROUND','CEIL','FLOOR','ABS','POWER','SQRT','MOD',
])

type Token = { type: 'kw' | 'fn' | 'str' | 'num' | 'cmt' | 'op' | 'plain'; value: string }

function tokenize(sql: string): Token[] {
  const tokens: Token[] = []
  let i = 0

  while (i < sql.length) {
    // Line comment
    if (sql[i] === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i)
      const val = end === -1 ? sql.slice(i) : sql.slice(i, end)
      tokens.push({ type: 'cmt', value: val })
      i += val.length
      continue
    }

    // Block comment
    if (sql[i] === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      const val = end === -1 ? sql.slice(i) : sql.slice(i, end + 2)
      tokens.push({ type: 'cmt', value: val })
      i += val.length
      continue
    }

    // Quoted identifier (double-quote)
    if (sql[i] === '"') {
      let j = i + 1
      while (j < sql.length && sql[j] !== '"') j++
      const val = sql.slice(i, j + 1)
      tokens.push({ type: 'str', value: val })
      i = j + 1
      continue
    }

    // String literal (single-quote)
    if (sql[i] === "'") {
      let j = i + 1
      while (j < sql.length && !(sql[j] === "'" && sql[j - 1] !== '\\')) j++
      const val = sql.slice(i, j + 1)
      tokens.push({ type: 'str', value: val })
      i = j + 1
      continue
    }

    // Number
    if (/[0-9]/.test(sql[i]) && (i === 0 || /[\s,(=<>!+\-*/]/.test(sql[i - 1]))) {
      let j = i
      while (j < sql.length && /[0-9.]/.test(sql[j])) j++
      tokens.push({ type: 'num', value: sql.slice(i, j) })
      i = j
      continue
    }

    // Identifier or keyword
    if (/[a-zA-Z_]/.test(sql[i])) {
      let j = i
      while (j < sql.length && /[a-zA-Z0-9_]/.test(sql[j])) j++
      const word = sql.slice(i, j)
      const upper = word.toUpperCase()
      if (KEYWORDS.has(upper)) {
        tokens.push({ type: 'kw', value: word })
      } else if (FUNCTIONS.has(upper)) {
        tokens.push({ type: 'fn', value: word })
      } else {
        tokens.push({ type: 'plain', value: word })
      }
      i = j
      continue
    }

    // Operators and punctuation
    if (/[>=<!\-+*/().,;]/.test(sql[i])) {
      tokens.push({ type: 'op', value: sql[i] })
      i++
      continue
    }

    // Whitespace / newlines / anything else
    tokens.push({ type: 'plain', value: sql[i] })
    i++
  }

  return tokens
}

const TOKEN_CLASSES: Record<Token['type'], string> = {
  kw: 'sql-kw',
  fn: 'sql-fn',
  str: 'sql-str',
  num: 'sql-num',
  op: 'sql-op',
  cmt: 'sql-cmt',
  plain: 'sql-plain',
}

type Props = {
  sql: string
  activeLine?: number
}

export function SqlHighlight({ sql, activeLine }: Props) {
  const lines = sql.split('\n')

  return (
    <div className="sql-editor w-full">
      {lines.map((line, lineIdx) => {
        const lineNum = lineIdx + 1
        const tokens = tokenize(line)
        const isActive = activeLine === lineNum

        return (
          <div
            key={lineIdx}
            className={clsx(
              'flex gap-0 min-w-0',
              isActive ? 'sql-active-line rounded-sm' : ''
            )}
          >
            {/* Line number */}
            <span className="select-none text-right pr-4 text-[#44444b] w-8 flex-shrink-0 text-[11px] pt-px">
              {lineNum}
            </span>
            {/* Code */}
            <span className="flex-1 whitespace-pre">
              {tokens.map((tok, ti) => (
                <span key={ti} className={TOKEN_CLASSES[tok.type]}>
                  {tok.value}
                </span>
              ))}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function clsx(...classes: (string | boolean | undefined)[]) {
  return classes.filter(Boolean).join(' ')
}
