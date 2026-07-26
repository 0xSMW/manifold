import { ConsoleGate } from "@/components/console/console-gate";
import { StorageConsole } from "@/components/storage/storage-console";

export default function StoragePage() {
  return (
    <ConsoleGate minRole="admin">
      <StorageConsole />
    </ConsoleGate>
  );
}
