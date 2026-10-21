# leave-management-system

Full-stack employee leave management system with leave balance tracking, approval workflows, team calendars and HR administration

## Как сделан проект

- **Инструмент:** Claude Code (расширение для VS Code).
- **Модель:** Claude Sonnet 5.5.
- **Почему:** Claude Code работает прямо в репозитории: читает код, правит файлы, запускает команды и тесты, а каждая сессия сохраняется в виде JSONL-лога с временными метками. Sonnet 5.5 выбран как баланс качества и расхода лимитов тарифа Pro.
- **Вне Claude Code:** отдельные вопросы (разбор требований, расход лимитов, формулировки для документации) обсуждались в чате claude.ai. Код проекта этим чатом не писался.
- **Лог работы:** `DECISIONS.md` (решения с датой и временем), история коммитов, экспорт сессий Claude Code в `docs/sessions/`.
- **Чужие решения и шаблоны:**
