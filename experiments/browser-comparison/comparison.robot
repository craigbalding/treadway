*** Settings ***
Library    Browser    jsextension=${CURDIR}/extension.cjs
Library    Collections
Library    OperatingSystem
Suite Setup    Start Comparison Browser
Suite Teardown    Close Browser    ALL
Test Setup    Open Fixture

*** Keywords ***
Start Comparison Browser
    New Browser    chromium    executablePath=${CHROME_BIN}    chromiumSandbox=${True}    reuse_existing=${False}

Open Fixture
    New Context    acceptDownloads=${False}
    New Page    ${ORIGIN}/?slow_query=1
    ${wait}=    Create Dictionary    expression=!!document.getElementById('choice')
    Perform    wait    ${wait}

*** Test Cases ***
Native Robot Keywords Drive The Controlled Widget
    Click    css=#choice
    Fill Text    css=#choice    Alpha
    Evaluate JavaScript    ${None}    async () => {await fetch('/comparison/release-query'); return true;}
    ${wait}=    Create Dictionary    expression=[...document.querySelectorAll('[role="option"]')].filter(e=>e.getBoundingClientRect().height>0).length===1
    Perform    wait    ${wait}
    ${choice}=    Create Dictionary    id=8    label=Alpha
    Perform    choose    ${choice}
    Click    css=#rerender
    ${empty}=    Create Dictionary
    ${response}=    Perform    save-choice    ${empty}
    Should Be Equal As Integers    ${response}[status]    201
    Get Attribute    css=#chosen    data-id    ==    8

Changed Target Stops The Following Native Robot Keyword
    ${values}=    Create Dictionary    start=2026-12-07    due=2026-12-11
    Perform    prepare-edit    ${values}
    Evaluate JavaScript    ${None}    () => {document.getElementById('date-form').action='/save/item/99'; return true;}
    ${empty}=    Create Dictionary
    Perform    commit-edit    ${empty}
    Create File    ${MARKER}    incorrectly advanced
