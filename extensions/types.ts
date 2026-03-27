export type AutoAttachMode = "never" | "session-create" | "always";
export type AttachLayout = "split-vertical" | "tab" | "split-horizontal";
export type WindowReuse = "last" | "named" | "never";

export interface TmuxSettings {
	autoAttach: AutoAttachMode;
	defaultLayout: AttachLayout;
	allowMute: boolean;
	maxWindows: number;
	windowReuse: WindowReuse;
}

export interface FeatureFlags {
	canAttach: boolean;
	canMute: boolean;
}

export interface SilenceConfig {
	timeout: number;
	factor: number;
	cap: number;
}

export interface TmuxInput {
	action: string;
	command?: string;
	name?: string;
	cwd?: string;
	silenceTimeout?: number;
	silenceBackoffFactor?: number;
	silenceBackoffCap?: number;
	window?: number | string;
	attach?: boolean;
	mode?: string;
}

export interface AttachOptions {
	session: string;
	mode?: AttachLayout;
	tmuxWindow?: number;
	piSessionId?: string | null;
}

export interface WindowInfo {
	index: number;
	title: string;
	active: boolean;
}
