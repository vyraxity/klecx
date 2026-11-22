# Legal text for image generation (removed while images are off)

Image generation is off for the text-only launch (`CLAUDE.md`, "Text-only launch"). On 2026-11-22 the owner asked to remove the image parts of the legal pages until images come back, so the Acceptable Use Policy and the Privacy Policy describe only what exists (rule 9). This file keeps the removed text, in `en`, `es` and `fr`, to restore **when images are turned back on** (step 3 of "To re-enable" in `CLAUDE.md`):

- **Acceptable Use Policy**: put `aupImagesSection` back as section 3 (`id: "images"`, after `prohibited`), renumber the following headings (3 → 4, 4 → 5), and put `aupEnforcementImageSentences` back at the start of the first paragraph of `enforcement`. Check the text still matches what the image code does (with Creem's Moderation API it will also say prompts are checked by Creem's moderation).
- **Privacy Policy**: put `privacyAiImageParagraph` back as the second paragraph of section `ai`.
- Bump `Legal.updatedAt`.

```json
{
  "en": {
    "aupImagesSection": {
      "id": "images",
      "heading": "3. Images",
      "paragraphs": [
        "When you create images, never request or create:"
      ],
      "bullets": [
        "Any sexual or sexualised content involving minors.",
        "Intimate or sexual images of real people without their consent.",
        "Face swaps, deepfakes or other manipulation of the face or likeness of real people.",
        "Extreme violence, or content that encourages self-harm."
      ]
    },
    "aupEnforcementImageSentences": "Image prompts are checked by automated rules before an image is created, and blocked prompts are refused. After three blocked image prompts in one day, image creation is turned off for that account until the next day. For blocked prompts we keep only a fingerprint and the reason, not the text.",
    "privacyAiImageParagraph": "Image prompts are checked by automated rules before an image is created. If a prompt is blocked, we keep only a fingerprint of it and the reason, not its text."
  },
  "es": {
    "aupImagesSection": {
      "id": "images",
      "heading": "3. Imágenes",
      "paragraphs": [
        "Al crear imágenes, nunca pidas ni crees:"
      ],
      "bullets": [
        "Ningún contenido sexual o sexualizado que involucre a menores.",
        "Imágenes íntimas o sexuales de personas reales sin su consentimiento.",
        "Intercambios de caras, deepfakes u otras manipulaciones de la cara o la imagen de personas reales.",
        "Violencia extrema, o contenido que fomente las autolesiones."
      ]
    },
    "aupEnforcementImageSentences": "Las solicitudes de imágenes se revisan con reglas automáticas antes de crear la imagen, y las solicitudes bloqueadas se rechazan. Tras tres solicitudes de imagen bloqueadas en un mismo día, la creación de imágenes se desactiva para esa cuenta hasta el día siguiente. De las solicitudes bloqueadas solo conservamos una huella y el motivo, no el texto.",
    "privacyAiImageParagraph": "Las solicitudes de imágenes se revisan con reglas automáticas antes de crear la imagen. Si una solicitud se bloquea, solo conservamos una huella de ella y el motivo, no su texto."
  },
  "fr": {
    "aupImagesSection": {
      "id": "images",
      "heading": "3. Images",
      "paragraphs": [
        "Lorsque vous créez des images, ne demandez ni ne créez jamais :"
      ],
      "bullets": [
        "Aucun contenu sexuel ou sexualisé impliquant des mineurs.",
        "Des images intimes ou sexuelles de personnes réelles sans leur consentement.",
        "Des échanges de visages, deepfakes ou autres manipulations du visage ou de l'image de personnes réelles.",
        "De la violence extrême, ou un contenu qui encourage l'automutilation."
      ]
    },
    "aupEnforcementImageSentences": "Les demandes d'images sont vérifiées par des règles automatiques avant la création de l'image, et les demandes bloquées sont refusées. Après trois demandes d'images bloquées dans la même journée, la création d'images est désactivée pour ce compte jusqu'au lendemain. Pour les demandes bloquées, nous ne gardons qu'une empreinte et le motif, pas le texte.",
    "privacyAiImageParagraph": "Les demandes d'images sont vérifiées par des règles automatiques avant la création de l'image. Si une demande est bloquée, nous ne gardons qu'une empreinte de celle-ci et le motif, pas son texte."
  }
}
```
