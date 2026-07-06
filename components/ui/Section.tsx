import { SectionHeader } from "./SectionHeader";

interface Props {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}

export function Section({ title, description, action, children }: Props) {
  return (
    <section>
      <SectionHeader title={title} description={description} action={action} className="mb-4" />
      {children}
    </section>
  );
}
