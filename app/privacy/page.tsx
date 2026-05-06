import Link from 'next/link'
import { ArrowLeft, Shield } from 'lucide-react'

export const metadata = {
  title: 'Privacy Notice & Data Protection Policy — Ceiba Data AI Explorer',
}

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-[#0d0d10] px-4 py-10">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-[12px] text-[#44444b] hover:text-[#7c68ff] transition-colors mb-6"
          >
            <ArrowLeft size={13} />
            Back to application
          </Link>

          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-[10px] bg-gradient-to-br from-[#7c68ff] to-[#4c8dff] flex items-center justify-center flex-shrink-0 shadow-lg shadow-[#7c68ff30]">
              <Shield size={18} className="text-white" />
            </div>
            <div>
              <h1 className="text-[22px] font-bold text-[#e8e8ea] tracking-tight leading-tight">
                Privacy Notice &amp; Data Protection Policy
              </h1>
              <p className="text-[13px] text-[#6c6c74] mt-1">Ceiba Healthcare — Ceiba Data AI Explorer</p>
            </div>
          </div>
        </div>

        {/* Content card */}
        <div className="bg-[#111114] border border-[#2a2a31] rounded-[16px] divide-y divide-[#2a2a31]">

          {/* Section 1: Data Controller */}
          <section className="p-6">
            <h2 className="text-[14px] font-semibold text-[#e8e8ea] mb-3">1. Data Controller</h2>
            <div className="space-y-1.5 text-[13px] text-[#6c6c74] leading-relaxed">
              <p><span className="text-[#a0a0a7] font-medium">Organisation:</span> Ceiba Healthcare</p>
              <p><span className="text-[#a0a0a7] font-medium">Data Protection Officer:</span> legal@ceiba-healthcare.com</p>
              <p><span className="text-[#a0a0a7] font-medium">KVKK Representative:</span> legal@ceiba-healthcare.com</p>
              <p className="text-[12px] text-[#44444b] mt-2">
                Ceiba Healthcare is registered as a data controller under KVKK (Law No. 6698) and processes personal
                data in accordance with applicable data protection regulations including GDPR, HIPAA, and KVKK.
              </p>
            </div>
          </section>

          {/* Section 2: What data we collect */}
          <section className="p-6">
            <h2 className="text-[14px] font-semibold text-[#e8e8ea] mb-3">2. What Data We Collect</h2>
            <ul className="space-y-2 text-[13px] text-[#6c6c74] leading-relaxed">
              <li className="flex items-start gap-2">
                <span className="text-[#7c68ff] mt-1 flex-shrink-0">•</span>
                <span><span className="text-[#a0a0a7] font-medium">Authentication data</span> — email address, hashed password, MFA configuration, login timestamps, IP addresses</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[#7c68ff] mt-1 flex-shrink-0">•</span>
                <span><span className="text-[#a0a0a7] font-medium">Query logs</span> — SQL queries executed, datasets accessed, query results metadata (row counts, column names)</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[#7c68ff] mt-1 flex-shrink-0">•</span>
                <span><span className="text-[#a0a0a7] font-medium">Clinical data from connected databases</span> — patient identifiers, clinical measurements, diagnoses, vital signs and other healthcare records from TeleHealth.DB and Eclinics.DB via authorised queries</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[#7c68ff] mt-1 flex-shrink-0">•</span>
                <span><span className="text-[#a0a0a7] font-medium">Usage audit logs</span> — actions performed within the platform, timestamps, user agent strings, session identifiers</span>
              </li>
            </ul>
          </section>

          {/* Section 3: Why we collect it */}
          <section className="p-6">
            <h2 className="text-[14px] font-semibold text-[#e8e8ea] mb-3">3. Why We Collect It</h2>
            <ul className="space-y-2 text-[13px] text-[#6c6c74] leading-relaxed">
              <li className="flex items-start gap-2">
                <span className="text-[#7c68ff] mt-1 flex-shrink-0">•</span>
                <span>Clinical data analysis and AI-assisted reporting to support healthcare operations</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[#7c68ff] mt-1 flex-shrink-0">•</span>
                <span>System security monitoring and access control enforcement</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[#7c68ff] mt-1 flex-shrink-0">•</span>
                <span>HIPAA and KVKK compliance obligations (audit trail, individual accountability)</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[#7c68ff] mt-1 flex-shrink-0">•</span>
                <span>Authentication and session management</span>
              </li>
            </ul>
          </section>

          {/* Section 4: Legal basis */}
          <section className="p-6">
            <h2 className="text-[14px] font-semibold text-[#e8e8ea] mb-3">4. Legal Basis for Processing</h2>
            <div className="space-y-3 text-[13px] text-[#6c6c74] leading-relaxed">
              <div>
                <p className="text-[#a0a0a7] font-medium">Legitimate Interest</p>
                <p className="text-[12px] mt-0.5">System security, access logging, audit trail maintenance, and operational analytics.</p>
              </div>
              <div>
                <p className="text-[#a0a0a7] font-medium">Vital Interests (Clinical Care)</p>
                <p className="text-[12px] mt-0.5">Access to clinical data to support healthcare delivery and patient safety decisions.</p>
              </div>
              <div>
                <p className="text-[#a0a0a7] font-medium">Legal Obligation (HIPAA Compliance)</p>
                <p className="text-[12px] mt-0.5">Audit log retention for 7 years, breach notification obligations, and minimum-necessary access controls required by 45 CFR 164.</p>
              </div>
            </div>
          </section>

          {/* Section 5: Data transfers */}
          <section className="p-6">
            <h2 className="text-[14px] font-semibold text-[#e8e8ea] mb-3">5. Data Transfers</h2>
            <div className="rounded-[10px] bg-[#16161a] border border-[#2a2a31] p-4 text-[13px] text-[#6c6c74] leading-relaxed">
              <p className="text-[#a0a0a7] font-medium mb-1.5">OpenAI (United States)</p>
              <p>
                AI narrative generation and chart suggestion features use OpenAI&apos;s API, hosted in the United
                States. Prior to any data being transmitted to OpenAI, a PHI scrubbing process removes all
                directly identifying patient data (patient IDs, names, national IDs, birth dates, and other
                protected health information). Only de-identified statistical summaries and column metadata
                are transmitted.
              </p>
              <p className="mt-2 text-[12px] text-[#44444b]">
                Transfer safeguard: KVKK Article 9 / GDPR Article 46 mechanisms — data minimisation and
                pseudonymisation applied prior to transfer. A Data Processing Agreement and HIPAA BAA are
                required and should be in place before production use with real PHI.
              </p>
            </div>
          </section>

          {/* Section 6: Retention */}
          <section className="p-6">
            <h2 className="text-[14px] font-semibold text-[#e8e8ea] mb-3">6. How Long We Keep It</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-[12px] text-[#6c6c74]">
                <thead>
                  <tr className="border-b border-[#2a2a31]">
                    <th className="text-left text-[#a0a0a7] font-medium pb-2 pr-4">Data Type</th>
                    <th className="text-left text-[#a0a0a7] font-medium pb-2">Retention Period</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1e1e23]">
                  <tr>
                    <td className="py-2 pr-4">Authentication logs</td>
                    <td className="py-2">7 years (HIPAA requirement)</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4">Query audit logs</td>
                    <td className="py-2">7 years (HIPAA requirement)</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4">Session data</td>
                    <td className="py-2">Cleared on logout or 8-hour session expiry</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4">Browser localStorage</td>
                    <td className="py-2">Cleared on logout</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4">Dashboard / chart data</td>
                    <td className="py-2">90 days from last access, then auto-deleted</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          {/* Section 7: Your rights */}
          <section className="p-6">
            <h2 className="text-[14px] font-semibold text-[#e8e8ea] mb-3">7. Your Rights (KVKK Article 11)</h2>
            <p className="text-[13px] text-[#6c6c74] mb-3">
              As a data subject under KVKK and GDPR, you have the following rights:
            </p>
            <ul className="space-y-2 text-[13px] text-[#6c6c74] leading-relaxed">
              {[
                ['Access', 'Request a copy of all personal data we hold about you.'],
                ['Correction', 'Request correction of inaccurate or incomplete data.'],
                ['Deletion', 'Request erasure of your data where no longer necessary.'],
                ['Restriction', 'Request restriction of processing in certain circumstances.'],
                ['Portability', 'Receive your data in a structured, machine-readable format.'],
                ['Objection', 'Object to processing based on legitimate interest.'],
              ].map(([right, desc]) => (
                <li key={right} className="flex items-start gap-2">
                  <span className="text-[#7c68ff] mt-1 flex-shrink-0">•</span>
                  <span><span className="text-[#a0a0a7] font-medium">{right}:</span> {desc}</span>
                </li>
              ))}
            </ul>
            <p className="text-[13px] text-[#6c6c74] mt-3">
              To exercise your rights, submit a request via our{' '}
              <Link href="/privacy/rights" className="text-[#7c68ff] hover:underline">
                Data Subject Rights Portal
              </Link>{' '}
              or email <span className="text-[#a0a0a7]">legal@ceiba-healthcare.com</span>. We will respond
              within 30 days as required by KVKK.
            </p>
          </section>

          {/* Section 8: Security */}
          <section className="p-6">
            <h2 className="text-[14px] font-semibold text-[#e8e8ea] mb-3">8. Security Measures</h2>
            <ul className="space-y-2 text-[13px] text-[#6c6c74] leading-relaxed">
              <li className="flex items-start gap-2">
                <span className="text-[#4dcc88] mt-1 flex-shrink-0">✓</span>
                <span>Encryption in transit (HTTPS/TLS) for all data transmission</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[#4dcc88] mt-1 flex-shrink-0">✓</span>
                <span>AES-GCM encryption at rest for locally cached sensitive data</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[#4dcc88] mt-1 flex-shrink-0">✓</span>
                <span>Role-based access control (admin, analyst, clinician roles)</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[#4dcc88] mt-1 flex-shrink-0">✓</span>
                <span>Tamper-evident audit logging with SHA-256 hash chaining</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[#4dcc88] mt-1 flex-shrink-0">✓</span>
                <span>Multi-factor authentication (MFA) for all users</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[#4dcc88] mt-1 flex-shrink-0">✓</span>
                <span>Automatic session timeout after 15 minutes of inactivity</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[#4dcc88] mt-1 flex-shrink-0">✓</span>
                <span>PHI scrubbing prior to any third-party AI API calls</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[#4dcc88] mt-1 flex-shrink-0">✓</span>
                <span>Anomaly detection and breach alerting for unusual access patterns</span>
              </li>
            </ul>
          </section>

          {/* Section 9: Contact */}
          <section className="p-6">
            <h2 className="text-[14px] font-semibold text-[#e8e8ea] mb-3">9. Contact & Data Protection Officer</h2>
            <div className="text-[13px] text-[#6c6c74] leading-relaxed space-y-1.5">
              <p><span className="text-[#a0a0a7] font-medium">Data Protection Officer:</span> Ceiba Healthcare Legal Team</p>
              <p><span className="text-[#a0a0a7] font-medium">Email:</span> legal@ceiba-healthcare.com</p>
              <p className="mt-2">
                For data subject requests, please use our{' '}
                <Link href="/privacy/rights" className="text-[#7c68ff] hover:underline">
                  Data Subject Rights Portal
                </Link>
                .
              </p>
            </div>
          </section>

          {/* Section 10: Last updated */}
          <section className="p-6">
            <p className="text-[12px] text-[#44444b]">
              <span className="text-[#6c6c74] font-medium">Last updated:</span> 2026-05-07 &nbsp;·&nbsp;
              This policy applies to all users of the Ceiba Data AI Explorer platform.
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}
