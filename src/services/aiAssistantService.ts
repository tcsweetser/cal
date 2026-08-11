// Interface stub only — see plan.md §5.5 and claude_code_prompt.md §6. No
// implementation in this project's current phases; this exists so the shape
// is fixed for whichever future phase wires it to Workers AI / an LLM.

export interface ConflictDetectionResult {
  hasConflict: boolean;
  conflictingEvents: Array<{ accountId: string; eventId: string; summary: string }>;
  suggestedAlternativeSlots?: Array<{ start: string; end: string }>;
}

export interface AICalendarAssistantService {
  detectConflicts(userId: string, startIso: string, endIso: string): Promise<ConflictDetectionResult>;
  generateDeclineResponse(eventDetails: any): Promise<string>;
}
