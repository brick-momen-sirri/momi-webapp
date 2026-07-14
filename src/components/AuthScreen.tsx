import { FormEvent, useState } from "react";
import { Loader2, LockKeyhole, Mail } from "lucide-react";
import type { AuthResult } from "../services/backendApi";
import { ThemeToggle, type ThemeMode } from "./ThemeToggle";

type AuthScreenProps = {
  onSignIn: (email: string, password: string) => Promise<AuthResult>;
  theme: ThemeMode;
  onThemeToggle: () => void;
};

export function AuthScreen({ onSignIn, theme, onThemeToggle }: AuthScreenProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setIsSubmitting(true);

    try {
      const result = await onSignIn(email, password);

      if (!result.ok) {
        setError(result.error);
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not check account.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="login-background grain flex min-h-screen items-center justify-center p-4">
      <div className="login-card grid w-full max-w-5xl overflow-hidden rounded-lg border border-line bg-white shadow-2xl lg:grid-cols-[0.95fr_1.05fr]">
        <section className="login-panel login-dark-aurora bg-ink p-8 text-white">
          <div className="login-stagger login-delay-1 flex h-12 w-12 items-center justify-center rounded-lg bg-white/10">
            <LockKeyhole className="h-6 w-6" />
          </div>
          <h1 className="login-stagger login-delay-2 mt-8 text-3xl font-bold">Momi-AI</h1>
          <p className="login-stagger login-delay-3 mt-4 max-w-sm text-sm leading-6 text-white/70">
            Production workspace for RunPod serverless ComfyUI generations, project media, credit tracking, and team-safe image and video workflows.
          </p>

          <div className="mt-10 grid gap-3 text-sm">
            <div className="login-stagger login-delay-4 rounded-lg border border-white/10 bg-white/5 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-white/50">Allowed domain</p>
              <p className="mt-1 font-semibold">@brickvisual.com</p>
            </div>
            <div className="login-stagger login-delay-5 rounded-lg border border-white/10 bg-white/5 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-white/50">Demo login</p>
              <p className="mt-1 font-semibold">name.surname@brickvisual.com</p>
              <p className="mt-1 text-xs text-white/60">Demo accounts are view-only.</p>
            </div>
          </div>
        </section>

        <section className="login-form-panel p-6 sm:p-8">
          <div className="login-form-item login-delay-3 mb-6 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-xl font-bold">Sign in</h2>
              <p className="mt-1 text-sm text-stone-500">Use the account created by an administrator.</p>
            </div>
            <ThemeToggle theme={theme} onToggle={onThemeToggle} />
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <label className="login-form-item login-delay-4 block">
              <span className="text-xs font-semibold uppercase tracking-wide text-stone-500">Email</span>
              <span className="relative mt-1 block">
                <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
                <input
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="name.surname@brickvisual.com"
                  className="h-11 w-full rounded-md border border-line pl-9 pr-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
                />
              </span>
            </label>

            <label className="login-form-item login-delay-5 block">
              <span className="text-xs font-semibold uppercase tracking-wide text-stone-500">Password</span>
              <span className="relative mt-1 block">
                <LockKeyhole className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
                <input
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  type="password"
                  placeholder="Password"
                  className="h-11 w-full rounded-md border border-line pl-9 pr-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
                />
              </span>
            </label>

            {error ? (
              <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
                {error}
              </p>
            ) : null}

            <div className="login-form-item login-delay-6">
              <button
                type="submit"
                disabled={isSubmitting}
                className="login-button flex h-11 w-full items-center justify-center gap-2 rounded-md bg-ember px-4 text-sm font-bold text-white transition hover:bg-orange-600 disabled:cursor-not-allowed disabled:bg-stone-300"
              >
                {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {isSubmitting ? "Checking account..." : "Sign in"}
              </button>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}
