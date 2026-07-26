"use client";

import { ConsoleGate } from "@/components/console/console-gate";
import { PageFrame } from "@/components/console/page-frame";
import { PublishConsole } from "@/components/publish/publish-console";

export default function PublishPage() {
  return (
    <ConsoleGate minRole="editor">
      <PageFrame
        description="Review the generated gateway configuration before publishing it"
        title="Publish"
      >
        <PublishConsole />
      </PageFrame>
    </ConsoleGate>
  );
}
