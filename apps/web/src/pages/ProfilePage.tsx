import { useAuth } from '../auth/AuthContext';
import { formatHireDate, orEmpty } from '../profile/format';

/** Профиль только на чтение (RULES §7-2, §7-6). */
export function ProfilePage() {
  const { profile } = useAuth();
  if (!profile) return null;
  return (
    <section>
      <h1>Профиль</h1>
      <dl>
        <dt>Имя</dt>
        <dd data-testid="profile-name">{profile.fullName}</dd>
        <dt>Дата выхода на работу</dt>
        <dd data-testid="profile-hire-date">{formatHireDate(profile.hireDate)}</dd>
        <dt>Команда</dt>
        <dd data-testid="profile-team">{orEmpty(profile.teamName)}</dd>
        <dt>Руководитель</dt>
        <dd data-testid="profile-manager">{orEmpty(profile.manager?.fullName)}</dd>
      </dl>
    </section>
  );
}
