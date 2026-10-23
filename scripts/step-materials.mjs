// Open through the real disclosure control; restored drafts may already be open.
export async function openCommentComposer(root) {
  const details = root.locator('.comment-details:visible').first();
  if (!await details.evaluate(node => node.open)) await details.locator(':scope > summary').click();
}
