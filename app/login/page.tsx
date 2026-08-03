import { LoginForm } from "@/components/login-form";

export default function LoginPage() {
  return (
    <main className="flex-1 flex items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm rise">
        <header className="text-center mb-8">
          <h1 className="font-display text-5xl tracking-tight text-pine-dark">
            Atlas
          </h1>
          <div className="rule-double mt-4 mb-3" />
          <p className="section-label">System of record · Research &amp; decisions</p>
        </header>
        <LoginForm />
        <p className="mt-6 text-center text-xs text-ink-faint">
          Access is by invitation. There is no public signup.
        </p>
      </div>
    </main>
  );
}
