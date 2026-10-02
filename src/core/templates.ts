/**
 * Шаблоны стратегий. Частота публикаций: стартовая гипотеза для согласования
 * с клиентом, а не правило алгоритма LinkedIn.
 */
export interface StrategyTemplate {
  label: string;
  goal: string;
  inputs: string[];
  pillars: string[];
  posts_per_week_hypothesis: number;
  primary_kpi: string;
  secondary_kpis: string[];
  weekly_cycle: string[];
  monthly_cycle: string[];
  content_matrix: { pillar: string; formats: string[]; share: number }[];
  approval_rules: string[];
  example_tasks: string[];
  adjust_when: string[];
  guardrails?: string[];
}

const commonWeekly = ["Проверка подключения и согласований", "Подготовка материалов недели", "Сравнение факта с планом", "Сбор доступных показателей созревших публикаций"];
const commonMonthly = ["Отчёт клиенту", "Ретроспектива гипотез", "Предложение изменений стратегу", "План следующего месяца"];

export const STRATEGY_TEMPLATES: Record<string, StrategyTemplate> = {
  executive: {
    label: "Руководитель", goal: "Профессиональный авторитет",
    inputs: ["Интервью о решениях", "Корпоративные правила коммуникаций", "Список подтверждённых кейсов", "Ограничения на упоминание компании"],
    pillars: ["Управленческие решения", "Отраслевые наблюдения", "Подтверждённые кейсы", "Команда и культура"],
    posts_per_week_hypothesis: 2, primary_kpi: "qualified_inquiries", secondary_kpis: ["impressions", "comments", "followers"],
    weekly_cycle: commonWeekly, monthly_cycle: commonMonthly,
    content_matrix: [{ pillar: "Управленческие решения", formats: ["text", "image"], share: 0.4 }, { pillar: "Отраслевые наблюдения", formats: ["text", "document"], share: 0.3 }, { pillar: "Подтверждённые кейсы", formats: ["text"], share: 0.2 }, { pillar: "Команда и культура", formats: ["image"], share: 0.1 }],
    approval_rules: ["Редактор → клиент", "Цифры компании согласуются с PR/legal клиента"],
    example_tasks: ["Интервью 30 минут о решении квартала", "Подтвердить цифры кейса"],
    adjust_when: ["4 недели без релевантных обращений", "Изменение позиции в компании"],
  },
  founder: {
    label: "Основатель", goal: "Развитие бизнеса и партнёрств",
    inputs: ["Проблемы рынка", "Подход компании", "Кейсы с разрешением", "Этапы развития"],
    pillars: ["Проблемы рынка", "Подход компании", "Кейсы", "Опыт построения бизнеса"],
    posts_per_week_hypothesis: 3, primary_kpi: "qualified_inquiries", secondary_kpis: ["impressions", "comments", "clicks"],
    weekly_cycle: commonWeekly, monthly_cycle: commonMonthly,
    content_matrix: [{ pillar: "Проблемы рынка", formats: ["text"], share: 0.3 }, { pillar: "Подход компании", formats: ["text", "image"], share: 0.3 }, { pillar: "Кейсы", formats: ["document"], share: 0.2 }, { pillar: "Опыт построения бизнеса", formats: ["text"], share: 0.2 }],
    approval_rules: ["Редактор → клиент", "Упоминание клиентов только с письменным разрешением"],
    example_tasks: ["Собрать 3 вопроса от отдела продаж", "Разрешение клиента на кейс"],
    adjust_when: ["Смена ICP", "Квалифицированные обращения ниже цели 2 цикла подряд"],
  },
  expert: {
    label: "Эксперт / консультант", goal: "Конверсия в консультации",
    inputs: ["Перечень услуг", "Доказательства компетенции (сертификаты, публикации)", "Путь записи на консультацию"],
    pillars: ["Разборы задач клиентов", "Методология", "Доказательства компетенции", "Ответы на частые вопросы"],
    posts_per_week_hypothesis: 3, primary_kpi: "qualified_inquiries", secondary_kpis: ["clicks", "comments"],
    weekly_cycle: commonWeekly, monthly_cycle: commonMonthly,
    content_matrix: [{ pillar: "Разборы задач клиентов", formats: ["text", "document"], share: 0.4 }, { pillar: "Методология", formats: ["text"], share: 0.3 }, { pillar: "Доказательства компетенции", formats: ["image"], share: 0.15 }, { pillar: "Ответы на частые вопросы", formats: ["text"], share: 0.15 }],
    approval_rules: ["Редактор → клиент"],
    example_tasks: ["Описать услугу и ограничения", "Подтвердить сертификаты"],
    adjust_when: ["Изменение пакета услуг"],
  },
  job_seeker: {
    label: "Специалист в поиске работы", goal: "Карьерные возможности",
    inputs: ["Целевые роли и компании", "Проекты с разрешением на упоминание", "Режим конфиденциальности"],
    pillars: ["Экспертиза", "Проекты", "Профессиональные разборы"],
    posts_per_week_hypothesis: 2, primary_kpi: "qualified_inquiries", secondary_kpis: ["profile_views", "impressions"],
    weekly_cycle: commonWeekly, monthly_cycle: commonMonthly,
    content_matrix: [{ pillar: "Экспертиза", formats: ["text"], share: 0.4 }, { pillar: "Проекты", formats: ["document", "image"], share: 0.3 }, { pillar: "Профессиональные разборы", formats: ["text"], share: 0.3 }],
    approval_rules: ["Каждый материал согласует владелец лично"],
    example_tasks: ["Обновить заголовок профиля (задача владельцу)", "Список 20 целевых компаний"],
    adjust_when: ["Новая целевая роль", "Получен оффер"],
    guardrails: ["При конфиденциальном поиске запрещены публичные сигналы о поиске работы без разрешения владельца"],
  },
  company_page: {
    label: "Компания", goal: "Доверие к бренду и спрос",
    inputs: ["Продуктовая линейка", "Кейсы", "Бренд-гайд", "Календарь событий"],
    pillars: ["Кейсы", "Продукты", "Команда", "Экспертные материалы"],
    posts_per_week_hypothesis: 3, primary_kpi: "clicks", secondary_kpis: ["impressions", "followers", "qualified_inquiries"],
    weekly_cycle: commonWeekly, monthly_cycle: commonMonthly,
    content_matrix: [{ pillar: "Кейсы", formats: ["document"], share: 0.3 }, { pillar: "Продукты", formats: ["image", "video"], share: 0.3 }, { pillar: "Команда", formats: ["image"], share: 0.2 }, { pillar: "Экспертные материалы", formats: ["text"], share: 0.2 }],
    approval_rules: ["Редактор → маркетинг клиента"],
    example_tasks: ["Собрать анонсы событий месяца"],
    adjust_when: ["Запуск продукта", "Смена позиционирования"],
  },
};

/** Ограничения конфиденциального поиска работы. */
const JOB_SIGNALS = [/ищу работу/i, /open to work/i, /looking for (a )?(new )?(job|role|opportunit)/i, /в поиске (работы|новой)/i, /#opentowork/i];
export function jobSearchSignals(text: string): string[] {
  return JOB_SIGNALS.filter((r) => r.test(text)).map((r) => r.source);
}

export function forbiddenTopicHits(text: string, topics: string[]): string[] {
  const t = text.toLowerCase();
  return topics.filter((x) => x && t.includes(x.toLowerCase()));
}
