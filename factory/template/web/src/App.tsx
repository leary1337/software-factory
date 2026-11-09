import { useState } from "react";
import { Button } from "@/components/ui/button";

export function App() {
  const [status, setStatus] = useState("unknown");

  async function check() {
    const response = await fetch("/api/health");
    const body: { status: string } = await response.json();
    setStatus(body.status);
  }

  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 p-8">
      <h1 className="text-2xl font-semibold">__PROJECT__</h1>
      <p>API status: {status}</p>
      <Button onClick={check}>Check API</Button>
    </main>
  );
}
