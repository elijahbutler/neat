import type { ColorRole, FontRole, RadiusRole } from '../tokens/model';

export interface SourceRef {
  file: string;
  line: number;
}

export interface PropInfo {
  name: string;
  type: string;
  optional: boolean;
  defaultValue?: string;
}

export interface VariantGroup {
  prop: string;
  options: string[];
  defaultValue?: string;
}

export interface ComponentInfo extends SourceRef {
  name: string;
  /** 'route' covers Next's other route files: loading, error, not-found, template, default, global-error. */
  kind: 'component' | 'page' | 'layout' | 'route';
  exported: boolean;
  /** File starts with 'use client'. */
  client: boolean;
  props: PropInfo[];
  variants: VariantGroup[];
}

export interface CssVariable extends SourceRef {
  name: string;
  value: string;
  resolved: string;
  /** Enclosing selectors or at-rules, outermost first, joined with " > ". */
  scope: string;
}

export interface RoleToken {
  variable: string;
  value: string;
}

export interface TokenProfile {
  variables: CssVariable[];
  colors: Partial<Record<ColorRole, RoleToken>>;
  fonts: Partial<Record<FontRole, RoleToken>>;
  radius: Partial<Record<RadiusRole, RoleToken>>;
  /** Roles with no matching variable, as "color.bgElevated", "radius.pill", ... */
  unresolved: string[];
}

export type ClassCategory = 'spacing' | 'radius' | 'fontSize' | 'color';

export interface ClassCount {
  value: string;
  count: number;
  example: SourceRef;
}

export interface ComponentUsage extends SourceRef {
  component: string;
  /** JSX sites that render the component. */
  uses: number;
  sites: SourceRef[];
  /** prop -> literal value (or "{expression}") -> count */
  props: Record<string, Record<string, number>>;
}

export interface TokenBypass extends SourceRef {
  kind: 'arbitrary-class' | 'inline-style';
  value: string;
  /** A token whose value equals the hardcoded one, when there is exactly such a token. */
  token?: string;
}

export interface RepeatedClassList {
  tag: string;
  classes: string;
  count: number;
  examples: SourceRef[];
}

export interface UsageProfile {
  components: ComponentUsage[];
  classes: Record<ClassCategory, ClassCount[]>;
  bypasses: TokenBypass[];
  repeatedClassLists: RepeatedClassList[];
}

export interface Fact {
  id: string;
  text: string;
  evidence: SourceRef[];
}

export interface DesignSystemProfile {
  schemaVersion: 1;
  project: string;
  commit: string | null;
  framework: { next: string | null; react: string | null; tailwind: string | null };
  /** Known UI libraries the repo depends on, so the edit agent reuses them (docs/resources/libraries.md). */
  uiLibraries: string[];
  components: ComponentInfo[];
  tokens: TokenProfile;
  usage: UsageProfile;
  facts: Fact[];
  warnings: string[];
}
