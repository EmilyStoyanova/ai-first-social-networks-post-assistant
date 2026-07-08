import { SectionHeader } from "./SectionHeader";

interface Props {
  id?: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}

export function Section({ id, title, description, action, children }: Props) {
  return (
    <section id={id}>
      <SectionHeader title={title} description={description} action={action} className="mb-4" />
      {children}
    </section>
  );
}
