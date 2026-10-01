import { LoginForm } from "@/components/login-form";

export default function LoginPage() {
  return (
    <main className="flex-1 flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md rise bg-surface rounded-[1.75rem] px-8 py-10 sm:px-10 shadow-[0_24px_60px_-32px_rgb(23_24_28/0.25)]">
        <header className="mb-8">
          <span className="grid place-items-center h-11 w-11 rounded-2xl bg-pine text-paper">
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M5 19 12 5l7 14M8.2 13.5h7.6" />
            </svg>
          </span>
          <h1 className="font-display text-4xl font-medium tracking-tight text-ink mt-6">
            Atlas
          </h1>
          <p className="text-sm text-ink-faint mt-1.5">
            System of record · Research &amp; decisions
          </p>
        </header>
        <LoginForm />
        <p className="mt-6 text-xs text-ink-faint">
          Access is by invitation. There is no public signup.
        </p>
      </div>
    </main>
  );
}
