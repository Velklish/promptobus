import { createRegistry, driverFor, openParticipant } from '../dist/index.js';
export function coreDriver(driver) {
    const checked = driver;
    return checked;
}
export function coreRegistry(registry) {
    const checked = registry;
    return checked;
}
export function createLibRegistry({ drivers, fallback }) {
    const checked = drivers;
    const registry = createRegistry({ drivers: checked, fallback });
    // Core copies the map and retains each input driver reference (src/driver.ts, createRegistry).
    return registry;
}
export function libDriverFor(registry, harness) {
    const driver = driverFor(coreRegistry(registry), harness);
    // Core returns an unchanged member of this private registry (src/driver.ts, driverFor).
    return driver;
}
export function libOpenParticipant(home, task, participant, registry, options) {
    const opened = openParticipant(home, task, participant, coreRegistry(registry), options);
    // openParticipant returns the registry driver without replacing it (src/driver.ts).
    return opened;
}
export function replaceLaunchMcpConfig(plan, config) {
    plan.mcpConfig = config;
    if (!plan.mcpConfigPath)
        return;
    const file = plan.files.find(entry => entry.path === plan.mcpConfigPath);
    if (!file)
        throw new Error('The launch plan has no file for its MCP configuration');
    file.text = `${JSON.stringify(config, null, 2)}\n`;
}
