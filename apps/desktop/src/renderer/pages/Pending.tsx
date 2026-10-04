// Placeholder shown for pages that haven't been ported to the desktop app yet (see sections.tsx).
import { IconHammer } from "@tabler/icons-react";
import { EmptyState } from "../design";

export default function Pending({ page }: { page: string }) {
  return (
    <EmptyState
      icon={<IconHammer size={30} stroke={1.4} />}
      title="This page is being ported"
      description={<>It will appear here once <code className="sem-code-inline">pages/{page}.tsx</code> exists and is registered in sections.tsx.</>}
      testId="page-pending"
    />
  );
}
