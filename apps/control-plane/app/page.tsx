"use client";

import { ConsoleGate } from "@/components/console/console-gate";
import { OverviewConsole } from "@/components/overview/overview-console";

export default function Home() {
  return (
    <ConsoleGate>
      <OverviewConsole />
    </ConsoleGate>
  );
}
