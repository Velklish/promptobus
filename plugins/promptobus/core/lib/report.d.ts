import { prepareNativeContext } from './native-participant-context.js';
import { contactsOf } from './store.js';
import { mcpNote, resolveEffort, resolvePermissionMode } from './spawn.js';
import { routeLift } from './models.js';
import type { DriverDenyTool, ParticipantV1, PromptobusHost, SessionSnapshot, TaskV1 } from '../dist/index.js';
import type { LibDriver, LibLaunchPlan } from './driver-runtime.js';
import type { SpawnOptions } from './spawn.js';
type ReportOptions = SpawnOptions;
interface ReporterPromptPlan {
    host: PromptobusHost;
    home: string;
    task: string;
    root: string;
    rules: string[];
    driver: LibDriver;
    contacts: ReturnType<typeof contactsOf>;
}
type ReportRouting = NonNullable<Awaited<ReturnType<typeof routeLift>>>;
interface ReportPlan extends ReporterPromptPlan {
    meta: TaskV1;
    former: ParticipantV1 | null;
    formerSessions: SessionSnapshot;
    name: string;
    model: string;
    effort: ReturnType<typeof resolveEffort>;
    permissionMode: ReturnType<typeof resolvePermissionMode>;
    addDirs: string[];
    selectedContext: ReturnType<typeof prepareNativeContext>;
    mcpConfigPath: string;
    settingsPath: string;
    guardCommand: string;
    env: NodeJS.ProcessEnv;
    commonEnv: NodeJS.ProcessEnv;
    denyTools: DriverDenyTool[];
    pluginDir: string | null;
    mcpNote: ReturnType<typeof mcpNote>;
    routing: ReportRouting['metadata'] | null;
    decision: ReportRouting['decision'] | null;
    routingSkipped: string | null;
    prompt: string;
    launch: LibLaunchPlan;
}
export { reportQuestion } from './report-channel.js';
export declare function planReport(rootOrHost: unknown, opts?: ReportOptions): Promise<ReportPlan>;
export declare function report(rootOrHost: unknown, opts?: ReportOptions): Promise<ReportPlan>;
