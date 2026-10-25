/** Заглушки: содержимое появится в S5 и S6; нужны, чтобы проверить защиту маршрутов по роли. */
export function ApprovalsPage() {
  return (
    <section>
      <h1>Согласование заявок</h1>
      <p className="muted">Раздел появится на этапе S5.</p>
    </section>
  );
}

export function HrPage() {
  return (
    <section>
      <h1>Экран HR</h1>
      <p className="muted">Раздел появится на этапе S6.</p>
    </section>
  );
}
