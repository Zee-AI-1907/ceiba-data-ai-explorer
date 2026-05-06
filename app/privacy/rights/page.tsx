'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Shield, CheckCircle2, Loader2 } from 'lucide-react'

type RequestType = 'access' | 'correct' | 'delete' | 'export' | 'object'

const REQUEST_TYPES: { value: RequestType; label: string; description: string }[] = [
  { value: 'access', label: 'Access', description: 'Request a copy of all personal data we hold about you' },
  { value: 'correct', label: 'Correct', description: 'Request correction of inaccurate or incomplete data' },
  { value: 'delete', label: 'Delete', description: 'Request erasure of your personal data' },
  { value: 'export', label: 'Export', description: 'Receive your data in a structured, machine-readable format' },
  { value: 'object', label: 'Object to Processing', description: 'Object to data processing based on legitimate interest' },
]

export default function DataSubjectRightsPage() {
  const [requestType, setRequestType] = useState<RequestType | ''>('')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [description, setDescription] = useState('')
  const [loading, setLoading] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [referenceId, setReferenceId] = useState('')
  const [error, setError] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const res = await fetch('/api/privacy/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, type: requestType, description }),
      })

      const data = await res.json()

      if (!res.ok) {
        setError(data.error ?? 'Something went wrong. Please try again.')
        return
      }

      setReferenceId(data.referenceId)
      setSubmitted(true)
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#0d0d10] px-4 py-10">
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <Link
            href="/privacy"
            className="inline-flex items-center gap-1.5 text-[12px] text-[#44444b] hover:text-[#7c68ff] transition-colors mb-6"
          >
            <ArrowLeft size={13} />
            Back to Privacy Policy
          </Link>

          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-[10px] bg-gradient-to-br from-[#7c68ff] to-[#4c8dff] flex items-center justify-center flex-shrink-0 shadow-lg shadow-[#7c68ff30]">
              <Shield size={18} className="text-white" />
            </div>
            <div>
              <h1 className="text-[22px] font-bold text-[#e8e8ea] tracking-tight leading-tight">
                Data Subject Rights Portal
              </h1>
              <p className="text-[13px] text-[#6c6c74] mt-1">
                Exercise your rights under KVKK Article 11 and GDPR
              </p>
            </div>
          </div>
        </div>

        {submitted ? (
          /* Success state */
          <div className="bg-[#111114] border border-[#2a2a31] rounded-[16px] p-8 text-center">
            <div className="flex justify-center mb-4">
              <CheckCircle2 size={48} className="text-[#4dcc88]" />
            </div>
            <h2 className="text-[18px] font-semibold text-[#e8e8ea] mb-2">Request Received</h2>
            <p className="text-[13px] text-[#6c6c74] leading-relaxed mb-4">
              We will respond within <span className="text-[#a0a0a7] font-medium">30 days</span> per
              KVKK requirements.
            </p>
            <div className="rounded-[10px] bg-[#16161a] border border-[#2a2a31] px-4 py-3 inline-block">
              <p className="text-[11px] text-[#6c6c74] mb-1">Reference ID</p>
              <p className="text-[14px] font-mono text-[#7c68ff] font-semibold">{referenceId}</p>
            </div>
            <p className="text-[11px] text-[#44444b] mt-4">
              Please keep this reference ID for your records. A confirmation will be sent to your email.
            </p>
            <div className="mt-6 flex justify-center gap-3">
              <Link
                href="/privacy"
                className="px-4 py-2 rounded-[8px] bg-[#16161a] border border-[#2a2a31] text-[12px] text-[#a0a0a7] hover:border-[#7c68ff] hover:text-[#7c68ff] transition-all"
              >
                Back to Privacy Policy
              </Link>
              <Link
                href="/"
                className="px-4 py-2 rounded-[8px] bg-[#7c68ff] hover:bg-[#8f7dff] text-white text-[12px] font-semibold transition-all"
              >
                Return to App
              </Link>
            </div>
          </div>
        ) : (
          /* Form */
          <div className="bg-[#111114] border border-[#2a2a31] rounded-[16px] p-6">
            {/* Info box */}
            <div className="rounded-[10px] bg-[#16161a] border border-[#2a2a31] p-4 mb-6">
              <p className="text-[12px] text-[#6c6c74] leading-relaxed">
                Under <span className="text-[#a0a0a7] font-medium">KVKK Article 11</span> and{' '}
                <span className="text-[#a0a0a7] font-medium">GDPR Chapter III</span>, you have the
                right to access, correct, delete, export, or object to the processing of your personal
                data. Complete the form below and we will respond within 30 days.
              </p>
            </div>

            <form onSubmit={handleSubmit} className="flex flex-col gap-5">
              {/* Request type */}
              <div className="flex flex-col gap-2">
                <label className="text-[12px] font-medium text-[#a0a0a7]">
                  Request Type <span className="text-[#ff5c6c]">*</span>
                </label>
                <div className="grid grid-cols-1 gap-2">
                  {REQUEST_TYPES.map((rt) => (
                    <label
                      key={rt.value}
                      className={`flex items-start gap-3 p-3 rounded-[10px] border cursor-pointer transition-all ${
                        requestType === rt.value
                          ? 'bg-[#7c68ff15] border-[#7c68ff] text-[#e8e8ea]'
                          : 'bg-[#16161a] border-[#2a2a31] text-[#6c6c74] hover:border-[#44444b]'
                      }`}
                    >
                      <input
                        type="radio"
                        name="requestType"
                        value={rt.value}
                        checked={requestType === rt.value}
                        onChange={() => setRequestType(rt.value)}
                        className="mt-0.5 accent-[#7c68ff]"
                        required
                      />
                      <div>
                        <p className="text-[12px] font-medium">{rt.label}</p>
                        <p className="text-[11px] text-[#44444b] mt-0.5">{rt.description}</p>
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              {/* Name */}
              <div className="flex flex-col gap-1.5">
                <label className="text-[12px] font-medium text-[#a0a0a7]" htmlFor="name">
                  Full Name <span className="text-[#ff5c6c]">*</span>
                </label>
                <input
                  id="name"
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your full name"
                  className="w-full h-10 px-3.5 rounded-[10px] bg-[#16161a] border border-[#2a2a31] text-[13px] text-[#e8e8ea] placeholder-[#44444b] outline-none focus:border-[#7c68ff] focus:ring-1 focus:ring-[#7c68ff40] transition-all"
                />
              </div>

              {/* Email */}
              <div className="flex flex-col gap-1.5">
                <label className="text-[12px] font-medium text-[#a0a0a7]" htmlFor="email">
                  Email Address <span className="text-[#ff5c6c]">*</span>
                </label>
                <input
                  id="email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="your@email.com"
                  className="w-full h-10 px-3.5 rounded-[10px] bg-[#16161a] border border-[#2a2a31] text-[13px] text-[#e8e8ea] placeholder-[#44444b] outline-none focus:border-[#7c68ff] focus:ring-1 focus:ring-[#7c68ff40] transition-all"
                />
              </div>

              {/* Description */}
              <div className="flex flex-col gap-1.5">
                <label className="text-[12px] font-medium text-[#a0a0a7]" htmlFor="description">
                  Description
                  <span className="text-[#44444b] font-normal ml-1">(optional but helpful)</span>
                </label>
                <textarea
                  id="description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Please describe your request in detail…"
                  rows={4}
                  className="w-full px-3.5 py-2.5 rounded-[10px] bg-[#16161a] border border-[#2a2a31] text-[13px] text-[#e8e8ea] placeholder-[#44444b] outline-none focus:border-[#7c68ff] focus:ring-1 focus:ring-[#7c68ff40] transition-all resize-none"
                />
              </div>

              {/* Error */}
              {error && (
                <div className="px-3.5 py-2.5 rounded-[10px] bg-[#ff5c6c15] border border-[#ff5c6c40] text-[12px] text-[#ff5c6c]">
                  {error}
                </div>
              )}

              {/* Submit */}
              <button
                type="submit"
                disabled={loading || !requestType}
                className="w-full min-h-[44px] rounded-[10px] bg-[#7c68ff] hover:bg-[#8f7dff] disabled:opacity-60 disabled:cursor-not-allowed text-white text-[13px] font-semibold transition-all flex items-center justify-center gap-2 shadow-md shadow-[#7c68ff30]"
              >
                {loading ? (
                  <>
                    <Loader2 size={15} className="animate-spin" />
                    Submitting…
                  </>
                ) : (
                  'Submit Request'
                )}
              </button>

              <p className="text-[11px] text-[#44444b] text-center leading-relaxed">
                By submitting, you confirm this request relates to your own personal data.
                We respond within 30 days per KVKK Article 11 requirements.
                <br />
                Questions? Email{' '}
                <span className="text-[#6c6c74]">legal@ceiba-healthcare.com</span>
              </p>
            </form>
          </div>
        )}
      </div>
    </div>
  )
}
