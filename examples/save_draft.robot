*** Settings ***
Documentation    Observe one explicit draft-save interaction in a configured form.
...              Application persistence requires a separate calibrated observer.
Library          treadway.robot.FormLibrary
...              ${CDP_HOST}    ${CDP_PORT}    ${TARGET_ID}
...              ${OUTPUT DIR}/form-attempts.jsonl    scope=${FORM_SCOPE}

*** Test Cases ***
Inspect And Observe Draft Save
    ${form}=       Inspect Form
    ${save}=       Get Form Action    ${form}    Save draft
    ${attempt}=    Attempt Form Action    ${form}    ${save}[ref]
    Should Be Equal    ${attempt}[completion]    unconfirmed
    ${history}=    Read Form Attempt History
    Log    ${attempt}[diagnosis]
