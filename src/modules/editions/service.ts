import {
  CurationEngine,
  type CurationOptions,
  type CurationResult,
  type EditionInput,
} from "../curation";
import type { ContentEnvelope } from "../../contracts";
import type { EditionRepository } from "./repository";

export class EditionService {
  constructor(
    private readonly repository: EditionRepository,
    private readonly engine: CurationEngine = new CurationEngine(),
  ) {}

  async create(
    request: EditionInput,
    candidates: readonly ContentEnvelope[],
    options: CurationOptions = {},
  ): Promise<CurationResult> {
    const result = this.engine.generate(request, candidates, options);
    await this.repository.saveEdition(result.slate, result.traces);
    return result;
  }

  resume(ownerId: string, editionId?: string) {
    return this.repository.resume(ownerId, editionId);
  }

  setPosition(ownerId: string, editionId: string, position: number) {
    return this.repository.setPosition(ownerId, editionId, position);
  }

  complete(ownerId: string, editionId: string) {
    return this.repository.markComplete(ownerId, editionId);
  }

  keep(ownerId: string, contentId: string, keptAt: string) {
    return this.repository.saveKeep(ownerId, contentId, keptAt);
  }

  removeKeep(ownerId: string, contentId: string) {
    return this.repository.removeKeep(ownerId, contentId);
  }

  listKeeps(ownerId: string) {
    return this.repository.listKeeps(ownerId);
  }
}
