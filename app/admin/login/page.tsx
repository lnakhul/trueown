import AdminLoginForm from "@/components/AdminLoginForm";

export const dynamic = "force-dynamic";

export default function AdminLoginPage({
  searchParams,
}: {
  searchParams: { error?: string };
}) {
  const notice =
    searchParams.error === "forbidden" ? "This account does not have admin access." : null;
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <AdminLoginForm notice={notice} />
    </main>
  );
}
