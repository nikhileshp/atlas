import { SetPasswordForm } from "@/components/set-password-form";

export default function SetPasswordPage() {
  return (
    <main className="flex-1 flex items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm rise">
        <header className="text-center mb-8">
          <h1 className="font-display text-4xl tracking-tight text-pine-dark">
            Welcome to Atlas
          </h1>
          <div className="rule-double mt-4 mb-3" />
          <p className="section-label">Choose a password to finish joining</p>
        </header>
        <SetPasswordForm />
      </div>
    </main>
  );
}
