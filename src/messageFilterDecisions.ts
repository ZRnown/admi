export interface IgnoredImagePolicyInput {
  shouldIgnoreImages: boolean;
  hasImage: boolean;
  hasTextContent: boolean;
}

export function shouldSkipMessageForIgnoredImages(input: IgnoredImagePolicyInput): boolean {
  if (!input.shouldIgnoreImages || !input.hasImage) {
    return false;
  }

  return !input.hasTextContent;
}
