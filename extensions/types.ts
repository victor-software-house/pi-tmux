export type AutoAttachMode = "never" | "session-create" | "always";
export type AttachLayout = "split-vertical" | "tab" | "split-horizontal";
export type WindowReuse = "last" | "named" | "never";
export type AutoFocus = "always" | "never";
export type CompletionDelivery = "steer" | "followUp" | "nextTurn";
export type ShellMode = "fresh" | "resume";

export interface TmuxSettings {
	autoAttach: AutoAttachMode;
	defaultLayout: AttachLayout;
	allowMute: boolean;
	maxWindows: number;
	windowReuse: WindowReuse;
	autoFocus: AutoFocus;
	defaultShellMode: ShellMode;
	completionDelivery: CompletionDelivery;
	completionPollIntervalMs: number;
	completionTriggerTurn: boolean;
}

export interface FeatureFlags {
	canAttach: boolean;
	canMute: boolean;
	autoAttach: AutoAttachMode;
	windowReuse: WindowReuse;
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
	shellMode?: ShellMode;
	attach?: boolean;
	mode?: string;
}

export interface AttachOptions {
	session: string;
	mode?: AttachLayout;
	tmuxWindow?: number;
	/** @deprecated Legacy only — piSessionId for it2api outside tmux */
	piSessionId?: string | null;
}

export interface WindowInfo {
	index: number;
	title: string;
	active: boolean;
}

export interface ManagedPaneInfo {
	paneId: string;
	ownerSession: string;
	title: string;
	session: string;
	windowIndex: number;
	paneIndex: number;
	active: boolean;
	visible: boolean;
	currentCommand: string;
	idle: boolean;
}
