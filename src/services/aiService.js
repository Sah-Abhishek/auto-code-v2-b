import OpenAI from 'openai';
import { config } from '../config.js';

class AIService {
  constructor() {
    this.client = new OpenAI({
      apiKey: config.ai.apiKey
    });
    this.model = config.ai.model;
  }

  /**
   * Build the system prompt for medical coding
   */
  getSystemPrompt() {
    return `You are an expert medical coder and clinical documentation specialist with extensive experience in ED/Emergency Department coding, ICD-10-CM diagnosis coding, CPT procedure coding, and modifier application.

Your task is to analyze clinical documents and extract ALL applicable codes organized into these specific categories:

1. **ED/EM Level**: Evaluation & Management codes for emergency department visits (99281-99285) or office/outpatient visits (99202-99215). Include MDM justification.

2. **Procedures (CPT)**: ALL CPT procedure codes for procedures performed. Multiple procedures are common - include ALL that apply.

3. **Primary Diagnosis (PDX)**: The SINGLE principal ICD-10-CM diagnosis code - the main reason for the visit.

4. **Secondary Diagnoses (SDX)**: ALL additional ICD-10-CM diagnosis codes. This typically includes:
   - Conditions treated during the visit
   - Comorbidities affecting care (diabetes, hypertension, etc.)
   - Chronic conditions being monitored
   - Risk factors (family history, tobacco use, etc.)
   - Status codes (Z codes for history, screening, etc.)
   - External cause codes if applicable
   
   IMPORTANT: Include ALL relevant secondary diagnoses - real medical charts often have 10-20+ secondary codes.

5. **Modifiers**: ALL applicable modifiers for procedures and E/M codes. Common modifiers:
   - 25: Significant separate E/M with procedure
   - 59/XE/XS/XP/XU: Distinct procedural services
   - 76/77: Repeat procedures
   - LT/RT: Laterality
   - PT: Physical therapy
   - TC/26: Technical/Professional component

6. **Feedback**: Documentation gaps, coding tips, and physician queries.

CRITICAL REQUIREMENTS:
- Extract ALL applicable codes, not just the most obvious ones
- For EVERY code, provide the EXACT text evidence from the document
- Use the most specific ICD-10 code possible (include all digits)
- Real charts typically have multiple procedures and many secondary diagnoses
- Be thorough - missing codes means missed revenue and incomplete clinical picture

OUTPUT FORMAT: Valid JSON only, no markdown.`;
  }

  /**
   * Build the user prompt with document content
   */
  buildUserPrompt(formattedDocuments, chartInfo) {
    const documentContent = formattedDocuments.map(doc => {
      const lines = doc.content.map(l => `[Line ${l.lineNumber}] ${l.text}`).join('\n');
      return `
=== DOCUMENT: ${doc.documentName} ===
Type: ${doc.documentType}
Total Lines: ${doc.totalLines}

CONTENT:
${lines}
`;
    }).join('\n\n');

    return `Analyze the following clinical documents and extract ALL applicable medical codes.

PATIENT INFORMATION:
- MRN: ${chartInfo.mrn || 'Not provided'}
- Chart Number: ${chartInfo.chartNumber || 'Not provided'}
- Facility: ${chartInfo.facility || 'Not provided'}
- Specialty: ${chartInfo.specialty || 'Not provided'}
- Date of Service: ${chartInfo.dateOfService || 'Not provided'}

CLINICAL DOCUMENTS:
${documentContent}

Extract ALL codes and respond with this JSON structure:

{
  "ai_narrative_summary": {
    "chief_complaint": {
      "text": "Brief description",
      "evidence": {
        "document_type": "",
        "document_name": "",
        "line_number": "",
        "exact_text": ""
      }
    },
    "history_of_present_illness": {
      "text": "HPI summary",
      "evidence": {
        "document_type": "",
        "document_name": "",
        "line_number": "",
        "exact_text": ""
      }
    },
    "timeline_of_care": [
      {
        "time": "",
        "event": "",
        "description": "",
        "evidence": {
          "document_type": "",
          "document_name": "",
          "line_number": "",
          "exact_text": ""
        }
      }
    ],
    "clinical_alerts": [
      {
        "alert": "",
        "severity": "high/medium/low",
        "evidence": {
          "document_type": "",
          "document_name": "",
          "line_number": "",
          "exact_text": ""
        }
      }
    ]
  },
  "coding_categories": {
    "ed_em_level": {
      "codes": [
        {
          "code": "99283",
          "description": "Emergency department visit, moderate severity",
          "level_justification": {
            "mdm_complexity": "Moderate",
            "number_of_diagnoses": "Single diagnosis",
            "data_reviewed": "What data was reviewed",
            "risk_of_complications": "Risk level and why"
          },
          "ai_reasoning": "Detailed reasoning for this E/M level",
          "confidence": "high",
          "evidence": [
            {
              "document_type": "",
              "document_name": "",
              "line_number": "",
              "exact_text": ""
            }
          ]
        }
      ]
    },
    "procedures": {
      "codes": [
        {
          "cpt_code": "45378",
          "procedure_name": "Colonoscopy, flexible; diagnostic",
          "description": "Description of procedure performed",
          "provider": "Provider name if found",
          "date": "Date performed",
          "findings": ["Finding 1", "Finding 2"],
          "ai_reasoning": "Why this code was selected",
          "confidence": "high",
          "evidence": {
            "document_type": "",
            "document_name": "",
            "line_number": "",
            "exact_text": ""
          }
        }
      ]
    },
    "primary_diagnosis": {
      "codes": [
        {
          "icd_10_code": "Z12.11",
          "description": "Encounter for screening for malignant neoplasm of colon",
          "ai_reasoning": "This is the main reason for the encounter",
          "confidence": "high",
          "evidence": [
            {
              "document_type": "",
              "document_name": "",
              "line_number": "",
              "exact_text": ""
            }
          ]
        }
      ]
    },
    "secondary_diagnoses": {
      "codes": [
        {
          "icd_10_code": "K635",
          "description": "Polyp of colon",
          "ai_reasoning": "Finding from procedure",
          "confidence": "high",
          "evidence": [
            {
              "document_type": "",
              "document_name": "",
              "line_number": "",
              "exact_text": ""
            }
          ]
        },
        {
          "icd_10_code": "Z83.71",
          "description": "Family history of colonic polyps",
          "ai_reasoning": "Documented family history relevant to screening",
          "confidence": "high",
          "evidence": [
            {
              "document_type": "",
              "document_name": "",
              "line_number": "",
              "exact_text": ""
            }
          ]
        },
        {
          "icd_10_code": "E11.9",
          "description": "Type 2 diabetes mellitus without complications",
          "ai_reasoning": "Documented comorbidity",
          "confidence": "medium",
          "evidence": [
            {
              "document_type": "",
              "document_name": "",
              "line_number": "",
              "exact_text": ""
            }
          ]
        }
      ]
    },
    "modifiers": {
      "codes": [
        {
          "modifier_code": "PT",
          "modifier_name": "Colorectal cancer screening test",
          "applies_to_code": "45378",
          "ai_reasoning": "Screening colonoscopy qualifier",
          "confidence": "high",
          "evidence": {
            "document_type": "",
            "document_name": "",
            "line_number": "",
            "exact_text": ""
          }
        },
        {
          "modifier_code": "XS",
          "modifier_name": "Separate Structure",
          "applies_to_code": "45385",
          "ai_reasoning": "Distinct anatomic site for additional procedure",
          "confidence": "high",
          "evidence": {
            "document_type": "",
            "document_name": "",
            "line_number": "",
            "exact_text": ""
          }
        }
      ]
    }
  },
  "feedback": {
    "documentation_gaps": [
      {
        "gap": "Description of gap",
        "impact": "How this affects coding",
        "suggestion": "What documentation would help"
      }
    ],
    "physician_queries_needed": [
      {
        "query": "Question for physician",
        "reason": "Why this clarification is needed",
        "priority": "high/medium/low"
      }
    ],
    "coding_tips": [
      {
        "tip": "Coding recommendation",
        "related_code": "Code this relates to"
      }
    ],
    "compliance_alerts": [
      {
        "alert": "Compliance concern",
        "severity": "high/medium/low"
      }
    ]
  },
  "medications": [
    {
      "name": "",
      "dose": "",
      "route": "",
      "frequency": "",
      "indication": ""
    }
  ],
  "vitals_summary": {
    "blood_pressure": "",
    "heart_rate": "",
    "respiratory_rate": "",
    "temperature": "",
    "oxygen_saturation": ""
  },
  "lab_results_summary": [
    {
      "test": "",
      "value": "",
      "unit": "",
      "flag": "normal/high/low/critical"
    }
  ],
  "metadata": {
    "patient_age": "",
    "sex": "",
    "date_of_service": "${chartInfo.dateOfService || ''}",
    "facility": "${chartInfo.facility || ''}",
    "attending_provider": "",
    "documents_analyzed": ${formattedDocuments.length}
  }
}

IMPORTANT CODING GUIDELINES:

1. **ED/EM Level Selection (99281-99285)**:
   - 99281: Straightforward MDM, self-limited problem
   - 99282: Low MDM, 2+ self-limited problems or 1 acute uncomplicated
   - 99283: Moderate MDM, 1 acute uncomplicated illness with systemic symptoms
   - 99284: Moderate-High MDM, 1 acute illness with systemic symptoms or 1 acute complicated injury
   - 99285: High MDM, 1+ acute/chronic illness posing threat to life or function

2. **Secondary Diagnoses - Include ALL of these if documented**:
   - Active conditions being treated
   - Chronic conditions (diabetes, hypertension, COPD, etc.)
   - Family history codes (Z80-Z84)
   - Personal history codes (Z85-Z87)
   - Status codes (Z93-Z99)
   - BMI codes if documented
   - Tobacco/alcohol use codes
   - Screening encounter codes
   - External cause codes for injuries

3. **Modifiers - Common combinations**:
   - E/M + Procedure: Usually needs modifier 25 on E/M
   - Multiple procedures: May need 59, XE, XS, XP, or XU
   - Screening procedures: PT modifier
   - Bilateral: 50 or RT/LT

4. Extract ALL codes supported by documentation - be thorough!
5. Every code MUST have evidence with exact_text from the document
6. Return ONLY valid JSON, no markdown code blocks`;
  }

  /**
   * Process documents through AI for ICD coding
   */
  async processForCoding(formattedDocuments, chartInfo) {
    try {
      console.log(`   🤖 Sending to OpenAI for coding analysis...`);

      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: 'system',
            content: this.getSystemPrompt()
          },
          {
            role: 'user',
            content: this.buildUserPrompt(formattedDocuments, chartInfo)
          }
        ],
        max_tokens: 8000,
        temperature: 0.1,
        response_format: { type: "json_object" }
      });

      console.log(`   ✅ AI analysis completed`);

      const textContent = response.choices[0]?.message?.content;
      if (!textContent) {
        throw new Error('No response from AI');
      }

      let result;
      try {
        result = JSON.parse(textContent);
      } catch (parseError) {
        const jsonMatch = textContent.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          result = JSON.parse(jsonMatch[0]);
        } else {
          console.error('   ⚠️ Failed to parse AI response');
          result = {
            raw_response: textContent,
            parse_error: parseError.message
          };
        }
      }

      // Transform to database format
      const transformedResult = this.transformToDBFormat(result);

      // Add token usage info
      transformedResult.ai_metadata = {
        model: this.model,
        prompt_tokens: response.usage?.prompt_tokens,
        completion_tokens: response.usage?.completion_tokens,
        total_tokens: response.usage?.total_tokens
      };

      return {
        success: true,
        data: transformedResult
      };
    } catch (error) {
      console.error(`   ❌ AI processing failed: ${error.message}`);

      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Transform AI response to database format
   */
  transformToDBFormat(aiResult) {
    const codingCategories = aiResult.coding_categories || {};

    // Extract codes arrays from the new structure
    const edEmCodes = codingCategories.ed_em_level?.codes || [];
    const procedureCodes = codingCategories.procedures?.codes || [];
    const primaryDxCodes = codingCategories.primary_diagnosis?.codes || [];
    const secondaryDxCodes = codingCategories.secondary_diagnoses?.codes || [];
    const modifierCodes = codingCategories.modifiers?.codes || [];

    return {
      // AI Summary
      ai_narrative_summary: aiResult.ai_narrative_summary,

      // All codes organized by category with the new array structure
      diagnosis_codes: {
        ed_em_level: edEmCodes,
        primary_diagnosis: primaryDxCodes,
        secondary_diagnoses: secondaryDxCodes,
        modifiers: modifierCodes,
        // Backward compatibility
        principal_diagnosis: primaryDxCodes[0] || null
      },

      // Procedures as array
      procedures: procedureCodes,

      // Feedback/Coding notes
      coding_notes: aiResult.feedback || {
        documentation_gaps: [],
        physician_queries_needed: [],
        coding_tips: [],
        compliance_alerts: []
      },

      // Other fields
      medications: aiResult.medications || [],
      vitals_summary: aiResult.vitals_summary || {},
      lab_results_summary: aiResult.lab_results_summary || [],
      metadata: aiResult.metadata || {}
    };
  }

  /**
   * Generate a summary for a single document
   */
  async generateDocumentSummary(ocrResult, chartInfo) {
    try {
      const text = typeof ocrResult.extractedText === 'string'
        ? ocrResult.extractedText
        : JSON.stringify(ocrResult.extractedText);

      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: 'system',
            content: `You are a clinical documentation specialist. Analyze the given clinical document and provide a structured summary. Return valid JSON only.`
          },
          {
            role: 'user',
            content: `Analyze this clinical document and provide a summary.

Document Type: ${ocrResult.documentType || 'Unknown'}
Filename: ${ocrResult.filename}
Facility: ${chartInfo.facility || 'Unknown'}
Date: ${chartInfo.dateOfService || 'Unknown'}

DOCUMENT CONTENT:
${text}

Respond with a JSON object:
{
  "document_type": "${ocrResult.documentType || 'Unknown'}",
  "title": "Document title based on content",
  "provider": "Provider name if found",
  "date": "Document date if found",
  "time": "Document time if found",
  "sections": [
    {
      "section_name": "Chief Complaint",
      "content": "Summary of section content",
      "source_line": "Line number where found"
    }
  ],
  "key_findings": [
    {
      "finding": "Important clinical finding",
      "category": "Category of finding",
      "source_section": "Where this was found"
    }
  ],
  "extracted_data": {
    "chief_complaint": "",
    "history_of_present_illness": "",
    "physical_examination": "",
    "assessment": "",
    "plan": "",
    "vitals": {
      "blood_pressure": "",
      "heart_rate": "",
      "respiratory_rate": "",
      "temperature": "",
      "oxygen_saturation": ""
    }
  },
  "clinical_relevance": "Brief summary of why this document is important for coding"
}`
          }
        ],
        max_tokens: 2000,
        temperature: 0.1,
        response_format: { type: "json_object" }
      });

      const textContent = response.choices[0]?.message?.content;
      if (!textContent) {
        throw new Error('No response from AI');
      }

      const result = JSON.parse(textContent);

      return {
        success: true,
        data: result
      };
    } catch (error) {
      console.error(`   ⚠️ Document summary failed: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }
}

export const aiService = new AIService();
