import Link from 'next/link'

/**
 * Self-signup is intentionally DISABLED for this clinical app.
 *
 * User accounts are provisioned by an administrator via the admin-only
 * user-create flow (POST /api/auth/register, requires the 'admin:manage'
 * permission). This page exists only to explain that and route users back to
 * sign-in — there is no public registration form.
 */
export default function SignUpPage() {
  return (
    <div className="min-h-screen bg-[#0d0d10] flex items-center justify-center px-4">
      <div className="flex flex-col items-center gap-6 w-full max-w-[360px]">
        <div className="text-center">
          <h1 className="text-[28px] font-bold text-[#e8e8ea] mb-1">Ceiba Data AI Explorer</h1>
          <p className="text-[13px] text-[#6c6c74]">Clinical Data Intelligence Platform</p>
        </div>

        <div className="w-full bg-[#16161a] border border-[#2a2a31] shadow-xl rounded-[10px] p-6 flex flex-col gap-4 text-center">
          <h2 className="text-[15px] font-semibold text-[#e8e8ea]">Accounts are invite-only</h2>
          <p className="text-[13px] text-[#a0a0a7] leading-relaxed">
            Self-registration is disabled for this clinical platform. Contact your
            organization administrator to have an account provisioned for you.
          </p>
          <Link
            href="/sign-in"
            className="h-10 flex items-center justify-center rounded-[8px] bg-[#7c68ff] hover:bg-[#6a58e8] text-[13px] font-semibold text-white transition-colors"
          >
            Back to sign in
          </Link>
        </div>

        <p className="text-[10px] text-[#44444b] max-w-[320px] text-center">
          This system contains Protected Health Information. Unauthorized access is prohibited and monitored.
        </p>
      </div>
    </div>
  )
}
