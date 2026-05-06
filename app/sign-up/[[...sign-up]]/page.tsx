import { SignUp } from '@clerk/nextjs'

export default function SignUpPage() {
  return (
    <div className="min-h-screen bg-[#0d0d10] flex items-center justify-center">
      <div className="flex flex-col items-center gap-6">
        <div className="text-center">
          <h1 className="text-[28px] font-bold text-[#e8e8ea] mb-1">Ceiba Data AI Explorer</h1>
          <p className="text-[13px] text-[#6c6c74]">Clinical Data Intelligence Platform</p>
        </div>
        <SignUp
          appearance={{
            variables: {
              colorPrimary: '#7c68ff',
              colorBackground: '#16161a',
              colorText: '#e8e8ea',
              colorTextSecondary: '#a0a0a7',
              colorInputBackground: '#1f1f25',
              colorInputText: '#e8e8ea',
              borderRadius: '10px',
            },
            elements: {
              card: 'bg-[#16161a] border border-[#2a2a31] shadow-xl',
              headerTitle: 'text-[#e8e8ea]',
              headerSubtitle: 'text-[#6c6c74]',
              formButtonPrimary: 'bg-[#7c68ff] hover:bg-[#6a58e8]',
              footerActionLink: 'text-[#7c68ff]',
            },
          }}
        />
        <p className="text-[10px] text-[#44444b] max-w-[320px] text-center">
          This system contains Protected Health Information. Unauthorized access is prohibited and monitored.
        </p>
      </div>
    </div>
  )
}
