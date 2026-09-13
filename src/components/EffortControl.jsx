import { useEffect, useRef, useState } from 'react'
import { IconSpark } from './Icons.jsx'

export const EFFORT_LEVELS = [
  { value: 'off', label: '关闭' },
  { value: 'low', label: '低' },
  { value: 'high', label: '高' },
  { value: 'max', label: '最大' },
]

const LANES = 2
const PER_LANE = 6
const CYCLE = 5.4
const FLOW_BASE = { low: 4.6, high: 2.4, max: 1.7 }

function shuffled(n) {
  const arr = [...Array(n).keys()]
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

function makeBubbles() {
  const out = []
  for (let lane = 0; lane < LANES; lane++) {
    const slots = shuffled(PER_LANE)
    const lanePhase = Math.random() * (CYCLE / PER_LANE)
    for (let n = 0; n < PER_LANE; n++) {
      // mixed sizes: occasional big, mostly mid/small — weighted so the field
      // reads varied instead of uniform
      const roll = Math.random()
      const size = roll < 0.22 ? 12 + Math.random() * 4
        : roll < 0.6 ? 9 + Math.random() * 2
          : 7 + Math.random() * 1.5
      out.push({
        size,
        top: 9 + lane * 10 + (Math.random() * 4 - 2),
        delay: slots[n] * (CYCLE / PER_LANE) + lanePhase + (Math.random() * 0.4 - 0.2),
        speed: 0.82 + Math.random() * 0.36,
        drift: 3.5 + Math.random() * 2,
        driftDur: 3 + Math.random() * 1.5,
        driftDelay: Math.random() * 2,
        float: 1.2 + Math.random() * 0.6,
        floatDur: 0.8 + Math.random() * 0.7,
        floatDelay: Math.random(),
        o: 0.45 + Math.random() * 0.5,
      })
    }
  }
  return out
}

export default function EffortControl({ effort, locked, onCommit }) {
  const [open, setOpen] = useState(false)
  const [bubbles, setBubbles] = useState(makeBubbles)
  const currentIndex = Math.max(0, EFFORT_LEVELS.findIndex(l => l.value === effort))
  const [sliderIndex, setSliderIndex] = useState(currentIndex)
  const rootRef = useRef(null)

  useEffect(() => { setSliderIndex(currentIndex) }, [currentIndex])

  useEffect(() => {
    if (open) setBubbles(makeBubbles())
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const commit = () => {
    const next = EFFORT_LEVELS[sliderIndex].value
    if (next !== effort) onCommit(next)
  }

  const level = EFFORT_LEVELS[sliderIndex]
  const current = EFFORT_LEVELS[currentIndex]
  const visible = level.value === 'off' ? [] : bubbles
  const flowDur = FLOW_BASE[level.value] ?? 3

  return (
    <div className={`effort ${open ? 'open' : ''}`} ref={rootRef}>
      <button
        className={`effort-btn level-${current.value} ${locked ? 'locked' : ''}`}
        onClick={() => setOpen(!open)}
        disabled={locked}
        title={`思考强度：${current.label}（点击调整）`}
      >
        <IconSpark size={15} />
        <span className="effort-btn-label">{current.label}</span>
      </button>

      {open && (
        <div className={`effort-pop level-${level.value}`}>
          <div className="effort-pop-head">
            <span className="effort-pop-title">思考强度</span>
            <span className="effort-pop-value">{level.label}</span>
          </div>

          <div className="slider-wrap">
            <svg className="slider-flow" width="100%" height="28" aria-hidden>
              {visible.map((b, i) => {
                const r = b.size / 2
                return (
                  <g
                    key={i}
                    className="b-move"
                    style={{
                      animationDelay: `${b.delay.toFixed(2)}s`,
                      animationDuration: `${(flowDur * b.speed).toFixed(2)}s`,
                    }}
                  >
                    <g
                      className="b-drift"
                      style={{
                        '--drift': `${b.drift.toFixed(1)}px`,
                        animationDelay: `${b.driftDelay.toFixed(2)}s`,
                        animationDuration: `${b.driftDur.toFixed(2)}s`,
                      }}
                    >
                      <circle
                        className="s-bubble"
                        cx={-16}
                        cy={b.top.toFixed(1)}
                        r={r.toFixed(1)}
                        style={{
                          opacity: b.o.toFixed(2),
                          '--float': `${b.float.toFixed(1)}px`,
                          animationDelay: `${b.floatDelay.toFixed(2)}s`,
                          animationDuration: `${b.floatDur.toFixed(2)}s`,
                        }}
                      />
                      <circle
                        className="s-bubble-shine"
                        cx={(-16 - r * 0.36).toFixed(1)}
                        cy={(b.top - r * 0.36).toFixed(1)}
                        r={Math.max(0.6, r * 0.2).toFixed(1)}
                        style={{ opacity: (b.o * 0.7).toFixed(2) }}
                      />
                    </g>
                  </g>
                )
              })}
            </svg>
            <input
              type="range"
              className="effort-pop-slider"
              min="0"
              max={EFFORT_LEVELS.length - 1}
              step="1"
              value={sliderIndex}
              onChange={e => setSliderIndex(Number(e.target.value))}
              onPointerUp={commit}
              onKeyUp={commit}
              disabled={locked}
            />
          </div>

          <div className="effort-ticks">
            {EFFORT_LEVELS.map((l, i) => (
              <span key={l.value} className={i === sliderIndex ? 'on' : ''}>{l.label}</span>
            ))}
          </div>

          <div className="effort-hint">
            {level.value === 'off' && '不思考，直接回答；最快最省'}
            {level.value === 'low' && '轻度推理；简单任务省 token'}
            {level.value === 'high' && '标准深度思考；日常默认'}
            {level.value === 'max' && '最长推理链；难题适用，更慢更贵'}
          </div>
        </div>
      )}
    </div>
  )
}
