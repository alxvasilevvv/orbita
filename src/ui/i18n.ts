import { EN } from "./en";

/**
 * Локализация интерфейса. Ключ: русская строка (основной язык), перевод: из словаря.
 * Отсутствующий перевод показывается по-русски; scripts/i18n-check.ts находит такие строки.
 * Динамические сообщения сервера (причины, ограничения данных) переводятся по шаблонам в tx().
 * Тексты ошибок валидации и прав приходят с сервера по-русски.
 */
export type Locale = "ru" | "en";
let locale: Locale = ((): Locale => {
  try { const v = localStorage.getItem("locale"); return v === "en" ? "en" : "ru"; } catch { return "ru"; }
})();

export function getLocale(): Locale { return locale; }
export function setLocale(l: Locale) {
  locale = l;
  try { localStorage.setItem("locale", l); } catch { /* приватный режим */ }
  document.documentElement.lang = l;
}
export function t(ru: string): string {
  return locale === "en" ? EN[ru] ?? ru : ru;
}
export function intlLocale() { return locale === "en" ? "en-GB" : "ru-RU"; }

/** Шаблоны динамических сообщений сервера: [регулярное выражение, функция перевода]. */
const PATTERNS: [RegExp, (...m: string[]) => string][] = [
  [/^Ошибки или неопределённость публикации: (\d+)$/, (n) => `Publishing errors or unknown outcomes: ${n}`],
  [/^Подключение LinkedIn: (\w+), нужно переподключение$/, (s) => `LinkedIn connection: ${s}, reconnection needed`],
  [/^(\d+) материал\(а\) ожидают согласования$/, (n) => `${n} post(s) awaiting approval`],
  [/^Просроченных задач: (\d+)$/, (n) => `Overdue tasks: ${n}`],
  [/^(\d+) из (\d+) за 30 дней$/, (a, b) => `${a} of ${b} in 30 days`],
  [/^Продукт «(.+)» требует одобрения LinkedIn и не подтверждён для нашего приложения$/, (p) => `The “${p}” product requires LinkedIn approval and is not confirmed for our app`],
  [/^Продукт «(.+)» не добавлен в приложение$/, (p) => `The “${p}” product has not been added to the app`],
  [/^Подключение в статусе (\w+)$/, (s) => `Connection status: ${s}`],
  [/^Пользователь не выдал разрешение (.+)$/, (p) => `The user did not grant the ${p} permission`],
  [/^Внутренняя пометка блокирует публикацию: (.+)$/, (n) => `An internal note blocks publishing: ${n}`],
  [/^Запрещённая тема: (.+)$/, (x) => `Forbidden topic: ${x}`],
  [/^Операций через API: (\d+)$/, (n) => `Operations via API: ${n}`],
  [/^Часы сверх бюджета стратегии: (.+) ч$/, (h) => `Hours over the strategy budget: ${h} h`],
  [/^Много доработок: (\d+)$/, (n) => `Many revisions: ${n}`],
  [/^Нет внутренней ставки у части записей времени \((\d+)\): себестоимость занижена$/, (n) => `Some time entries (${n}) have no internal rate: cost is understated`],
  [/^Цена AI-провайдера не задана для (\d+) вызовов$/, (n) => `AI provider price not set for ${n} calls`],
  [/^Свободных окон меньше плана: (\d+) из (\d+)\. Добавьте окна или сократите частоту$/, (a, b) => `Fewer free windows than planned: ${a} of ${b}. Add windows or reduce frequency`],
  [/^(.+): время не существует из-за перехода часов, слот пропущен$/, (x) => `${x}: this time does not exist because of a clock change, slot skipped`],
  [/^Событие «(.+)» раньше, чем успевает пройти согласование$/, (x) => `Event “${x}” is earlier than approval can be completed`],
  [/^Основной показатель «(.+)» за месяц не внесён: прогресс оценивается по возможностям и производству$/, (k) => `The primary metric “${k}” was not entered for the month: progress is judged by opportunities and production`],
  [/^Сравнение материалов по (\d+) публикациям: малая выборка$/, (n) => `Comparison based on ${n} posts: small sample`],
  [/^Исключены выбросы: (\d+)$/, (n) => `Outliers excluded: ${n}`],
  [/^Малые выборки не использовались для выводов: (.+)$/, (x) => `Small samples were not used for conclusions: ${x}`],
];

const STATIC: Record<string, string> = {
  "Нет утверждённой стратегии": "No approved strategy",
  "Публикация приостановлена": "Publishing paused",
  "Подключение скоро истечёт": "Connection expires soon",
  "план не утверждён": "plan not approved",
  "LinkedIn не предоставляет подтверждённого API для этой операции": "LinkedIn offers no confirmed API for this operation",
  "Аккаунт не подключён через OAuth": "The account is not connected via OAuth",
  "Нет версии текста": "No text version",
  "Публичный сигнал о поиске работы при конфиденциальном режиме": "A public job-search signal in confidential mode",
  "Часть вложений не найдена": "Some attachments were not found",
  "Вложение принадлежит другому аккаунту": "An attachment belongs to another account",
  "Вложение не прошло проверку": "An attachment failed the check",
  "Видео и документы через API пока не публикуются: нужна публикация через человека": "Video and documents are not yet published via the API: publish by a person",
  "Себестоимость = трудозатраты × внутренняя ставка + прямые расходы (AI). Накладные расходы распределяются отдельно.": "Cost = labour × internal rate + direct costs (AI). Overheads are allocated separately.",
  "Себестоимость = минуты × внутренняя ставка / 60 + AI + инфраструктура × доля аккаунтов клиента": "Cost = minutes × internal rate / 60 + AI + infrastructure × the client’s share of accounts",
  "INFRA_COST_MONTH_USD не задан: накладные расходы не распределены": "INFRA_COST_MONTH_USD is not set: overheads are not allocated",
  "Время за месяц не учтено: маржа не рассчитывается": "No time logged for the month: margin is not computed",
  "Сравниваются только публикации старше 7 дней с известными показами. Это наблюдение, а не доказанная причина.": "Only posts older than 7 days with known impressions are compared. This is an observation, not a proven cause.",
  "Окна публикации не заданы: использована гипотеза вт и чт 09:00 местного времени аккаунта": "No posting windows set: using the hypothesis of Tue and Thu 09:00 in the account’s local time",
  "Время публикации: стартовая гипотеза, согласованная с клиентом. Статистически лучшее время на малой выборке не определяется": "Posting time is a starting hypothesis agreed with the client. A statistically best time cannot be determined from a small sample",
  "Показатели публикаций за период отсутствуют: источник не подключён или данные не внесены. Отсутствие данных не означает нулевой результат.": "No post metrics for the period: the source is not connected or data was not entered. Missing data does not mean a zero result.",
  "Часть публикаций подтверждена ручной отметкой, а не API.": "Some posts were confirmed by a manual mark, not by the API.",
  "Журнал платформы не является полной историей активности аккаунта в LinkedIn.": "The platform log is not the account’s full LinkedIn activity history.",
  "У публикаций месяца нет показателей с окном наблюдения не менее 7 дней: лучшие материалы не определяются": "This month’s posts have no metrics with an observation window of at least 7 days: best posts cannot be determined",
  "Сравнение месяцев учитывает только данные из тех же источников; журнал платформы не является полной историей аккаунта": "Month comparison uses data from the same sources only; the platform log is not the account’s full history",
  "Interaction rate по показам (определение платформы), только публикации с окном наблюдения ≥ 7 дней": "Interaction rate by impressions (platform definition), posts with an observation window of ≥ 7 days only",
  "Сравниваются разные публикации в разных условиях: это последовательный эксперимент, а не A/B-тест": "Different posts are compared under different conditions: this is a sequential experiment, not an A/B test",
  "Корреляция не доказывает причину": "Correlation does not prove causation",
  "Данные LinkedIn API не использованы: цели использования для рекомендаций не подтверждены": "LinkedIn API data was not used: permitted purposes for recommendations are not confirmed",
  "Работа через людей, пока подключение недоступно": "Work through people while the connection is unavailable",
  "Определение платформы Agency LinkedIn OS (v1): (reactions + comments + reposts) / impressions × 100%. Не является метрикой LinkedIn.": "Agency LinkedIn OS platform definition (v1): (reactions + comments + reposts) / impressions × 100%. Not a LinkedIn metric.",
  "Оценка AI: редакторская рекомендация, а не прогноз охвата": "The AI score is an editorial recommendation, not a reach forecast",
};

/** Перевод динамического сообщения сервера: точное совпадение, затем шаблоны. */
export function tx(ru: string | null | undefined): string {
  if (ru == null) return "";
  if (locale !== "en") return ru;
  if (STATIC[ru]) return STATIC[ru];
  if (EN[ru]) return EN[ru];
  for (const [re, f] of PATTERNS) {
    const m = re.exec(ru);
    if (m) return f(...m.slice(1));
  }
  return ru;
}
