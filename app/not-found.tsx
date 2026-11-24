import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-6 text-center">
      <div>
        <p className="font-ui text-xs uppercase tracking-[0.2em] text-muted-foreground">
          404
        </p>
        <h1 className="mt-3 font-ui text-lg font-medium text-foreground">
          This page could not be found.
        </h1>
        <Link
          href="/"
          className="mt-5 inline-block font-ui text-xs text-muted-foreground underline underline-offset-4 transition-colors hover:text-foreground"
        >
          Back to sessions
        </Link>
      </div>
    </main>
  );
}
