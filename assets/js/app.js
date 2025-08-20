import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { L6_WHITELIST } from '/assets/js/whitelist.js';

const SUPABASE_URL = 'https://gjvtncdjcslnkfctqnfy.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdqdnRuY2RqY3NsbmtmY3RxbmZ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM5NzM0MDEsImV4cCI6MjA1OTU0OTQwMX0.AzALxUUvYLJJtDkvxt7efJ7bGxeKmzOs-fT5bQOndiU';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// State variables
let verifiedStudent = null;
let otpCooldownTimer = null;

// DOM Elements - we'll grab these when DOM is ready
let authView, enrolmentView, formFindStudent, formVerifyCode;
let signOutButton, changeNameButton, fullNameInput, emailInput, tokenInput;
let courseListDiv, studentNameDisplay, studentEmailDisplay;

// --- Helper Functions ---

function normaliseNameForMatching(name) {
    if (!name) return '';
    return name.toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function findStudentInWhitelist(inputName) {
    const normalised = normaliseNameForMatching(inputName);
    const parts = normalised.split(' ').filter(p => p.length > 0);
    
    if (parts.length < 2) return null;
    
    // Try different name combinations
    const attempts = [
        parts.join(' '), // full name as entered
        `${parts[0]} ${parts[parts.length - 1]}`, // first + last
        parts.length > 2 ? `${parts[0]} ${parts[1]}` : null, // first + middle
        parts.length > 2 ? `${parts[1]} ${parts[parts.length - 1]}` : null // middle + last
    ].filter(Boolean);
    
    for (const attempt of attempts) {
        const student = L6_WHITELIST.students.find(s => 
            normaliseNameForMatching(s.key) === attempt ||
            normaliseNameForMatching(s.name) === attempt
        );
        if (student) return student;
    }
    // Fuzzy token-subset match: allow two-part input to match longer names
    const inputTokens = parts;
    const candidatesWithScore = [];
    for (const s of L6_WHITELIST.students) {
        const candidateStr = normaliseNameForMatching(s.key || s.name || '');
        if (!candidateStr) continue;
        const candidateTokens = candidateStr.split(' ').filter(Boolean);
        const isSubset = inputTokens.every(t => candidateTokens.includes(t));
        if (isSubset) {
            // Score by number of overlapping tokens (prefer fuller matches)
            const overlap = inputTokens.filter(t => candidateTokens.includes(t)).length;
            candidatesWithScore.push({ s, overlap, tokenCount: candidateTokens.length });
        }
    }
    if (candidatesWithScore.length === 1) {
        return candidatesWithScore[0].s;
    }
    if (candidatesWithScore.length > 1) {
        // Pick the one with highest overlap, then the shortest name (more specific)
        candidatesWithScore.sort((a,b)=> (b.overlap - a.overlap) || (a.tokenCount - b.tokenCount));
        return candidatesWithScore[0].s;
    }
    return null;
}

// --- State Management ---

const switchView = (view) => {
  if (!authView || !enrolmentView) return;
  
  if (view === 'enrolment') {
    authView.classList.add('hidden');
    enrolmentView.classList.remove('hidden');
  } else {
    authView.classList.remove('hidden');
    enrolmentView.classList.add('hidden');
  }
};

const switchForm = (form) => {
  if (!formFindStudent || !formVerifyCode) return;
  
  if (form === 'verify') {
    formFindStudent.classList.add('hidden');
    formVerifyCode.classList.remove('hidden');
    // Update display with student name
    if (studentNameDisplay && verifiedStudent) {
      studentNameDisplay.textContent = verifiedStudent.name;
    }
  } else {
    formFindStudent.classList.remove('hidden');
    formVerifyCode.classList.add('hidden');
  }
};

// --- Event Handler Functions ---

async function handleFindStudent(e) {
  e.preventDefault();
  
  const submitBtn = formFindStudent.querySelector('button[type="submit"]');
  const originalText = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = 'Searching...';
  
  try {
    const fullName = fullNameInput.value.trim();
    
    // First check the whitelist
    const whitelistMatch = findStudentInWhitelist(fullName);
    
    if (!whitelistMatch) {
      throw new Error('Name not found in the L6 student list. Please check your spelling and try again.');
    }
    
    // Use the canonical name from whitelist for database lookup
    const { data, error } = await supabase.rpc('find_enrichment_student', {
      p_full_name: whitelistMatch.name
    });
    
    if (error) throw error;
    // Fallback: if not found in DB, proceed with whitelist data (assume L6)
    if (!data || data.length === 0) {
      verifiedStudent = {
        name: whitelistMatch.name,
        forename: whitelistMatch.name.split(' ')[0] || '',
        surname: whitelistMatch.name.split(' ').slice(1).join(' ') || '',
        form: 'L6'
      };
    } else {
      // Store verified student info from DB
      const db = data[0];
      const rawForm = (db.form || db.form_group || db.formGroup || '').toString();
      const normalisedForm = /^\s*L6/i.test(rawForm) ? 'L6' : rawForm;
      verifiedStudent = {
        ...db,
        form: normalisedForm || 'L6',
        name: whitelistMatch.name,
        whitelistKey: whitelistMatch.key
      };
    }
    
    // Skip email/OTP for now – go straight to enrolment
    sessionStorage.setItem('casStudent', JSON.stringify(verifiedStudent));
    // Backward-compat keys used by enrolment.html
    sessionStorage.setItem('casStudentName', verifiedStudent.name || '');
    if (verifiedStudent.form) sessionStorage.setItem('casForm', verifiedStudent.form);
    if (verifiedStudent.school_id || verifiedStudent.schoolId) {
      sessionStorage.setItem('casStudentId', String(verifiedStudent.school_id || verifiedStudent.schoolId));
    }
    window.location.href = '/pages/enrolment.html';
    
  } catch (error) {
    alert(`Error: ${error.message}`);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = originalText;
  }
}

async function handleSendCode(e) {
  e.preventDefault();
  
  const email = emailInput.value.trim();
  const sendBtn = document.getElementById('sendCodeBtn');
  
  if (!email) {
    alert('Please enter your school email address.');
    return;
  }
  
  if (!email.endsWith('@stpauls.br')) {
    alert('Please use your St. Paul\'s school email (@stpauls.br).');
    return;
  }
  
  sendBtn.disabled = true;
  sendBtn.textContent = 'Sending...';
  
  try {
    // Use Supabase Auth OTP - this will send a 6-digit code to the email
    const { data, error } = await supabase.auth.signInWithOtp({
      email: email,
      options: {
        shouldCreateUser: true, // Allow creating user if doesn't exist
        emailRedirectTo: undefined // No redirect, just OTP
      }
    });
    
    if (error) {
      // Check if it's a rate limit error
      if (error.message.includes('rate')) {
        throw new Error('Too many attempts. Please wait a moment and try again.');
      }
      throw error;
    }
    
    // Store email for later
    if (studentEmailDisplay) {
      studentEmailDisplay.textContent = email;
    }
    sessionStorage.setItem('casStudentEmail', email);
    
    alert('Verification code sent! Please check your email inbox (and spam folder).');
    
    // Start cooldown timer (60 seconds for Supabase default)
    let cooldown = 60;
    sendBtn.textContent = `Resend in ${cooldown}s`;
    
    otpCooldownTimer = setInterval(() => {
      cooldown--;
      if (cooldown <= 0) {
        clearInterval(otpCooldownTimer);
        sendBtn.disabled = false;
        sendBtn.textContent = 'Resend Code';
      } else {
        sendBtn.textContent = `Resend in ${cooldown}s`;
      }
    }, 1000);
    
  } catch (error) {
    console.error('Error sending OTP:', error);
    alert(`Error sending code: ${error.message}`);
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send Code';
  }
}

async function handleVerifyCode(e) {
  e.preventDefault();
  
  const email = emailInput.value.trim();
  const token = tokenInput.value.trim();
  const verifyBtn = document.getElementById('verifyBtn');
  
  if (!email || !token) {
    alert('Please enter both email and verification code.');
    return;
  }
  
  verifyBtn.disabled = true;
  verifyBtn.textContent = 'Verifying...';
  
  try {
    // TEMPORARY: Accept test code "123456" for development
    if (token === '123456' && window.location.hostname === 'localhost') {
      console.warn('Using test code for development');
      sessionStorage.setItem('casStudent', JSON.stringify(verifiedStudent));
      sessionStorage.setItem('casStudentEmail', email);
      window.location.href = '/pages/enrolment.html';
      return;
    }
    
    const { data, error } = await supabase.auth.verifyOtp({
      email: email,
      token: token,
      type: 'email'
    });
    
    if (error) throw error;
    
    // Store student info in session
    sessionStorage.setItem('casStudent', JSON.stringify(verifiedStudent));
    sessionStorage.setItem('casStudentEmail', email);
    
    // Navigate to enrolment page
    window.location.href = '/pages/enrolment.html';
    
  } catch (error) {
    alert(`Verification failed: ${error.message}`);
  } finally {
    verifyBtn.disabled = false;
    verifyBtn.textContent = 'Verify & Continue';
  }
}

async function handleChangeName() {
  verifiedStudent = null;
  fullNameInput.value = '';
  emailInput.value = '';
  tokenInput.value = '';
  switchForm('find');
}

// --- Initialisation ---

document.addEventListener('DOMContentLoaded', () => {
  // Get all DOM elements
  authView = document.getElementById('auth-view');
  enrolmentView = document.getElementById('enrolment-view');
  formFindStudent = document.getElementById('form-find-student');
  formVerifyCode = document.getElementById('form-verify-code');
  signOutButton = document.getElementById('sign-out-button');
  changeNameButton = document.getElementById('change-name-button');
  fullNameInput = document.getElementById('fullName');
  emailInput = document.getElementById('email');
  tokenInput = document.getElementById('token');
  courseListDiv = document.getElementById('course-list');
  studentNameDisplay = document.getElementById('student-name-display');
  studentEmailDisplay = document.getElementById('student-email-display');
  
  // Attach event listeners
  if (formFindStudent) {
    formFindStudent.addEventListener('submit', handleFindStudent);
  }
  
  if (formVerifyCode) {
    formVerifyCode.addEventListener('submit', handleVerifyCode);
    
    const sendCodeBtn = document.getElementById('sendCodeBtn');
    if (sendCodeBtn) {
      sendCodeBtn.addEventListener('click', handleSendCode);
    }
    
    const verifyBtn = document.getElementById('verifyBtn');
    if (verifyBtn) {
      // Verify button is part of the form submit
    }
  }
  
  if (changeNameButton) {
    changeNameButton.addEventListener('click', handleChangeName);
  }
  
  // Check if we're on the enrolment page
  if (window.location.pathname.includes('enrolment')) {
    checkEnrolmentAuth();
  } else {
    // Start with name entry
    switchView('auth');
    switchForm('find');
  }
});

// --- Enrolment Page Functions ---

async function checkEnrolmentAuth() {
  const studentJson = sessionStorage.getItem('casStudent');
  if (!studentJson) {
    alert('Please start by entering your name.');
    window.location.href = '/';
    return;
  }
  
  verifiedStudent = JSON.parse(studentJson);
  fetchAndDisplayCourses();
}
// Fetch available courses from the view and display cards
async function fetchAndDisplayCourses() {
  if (!courseListDiv) return;
  courseListDiv.innerHTML = '<p class="card-help">Loading available courses…</p>';
  try {
    const { data: courses, error } = await supabase
      .from('CasCoursesAvailability')
      .select('*')
      .eq('isActive', true)
      .order('sortOrder', { ascending: true });
    if (error) throw error;
    if (!courses || courses.length === 0) {
      courseListDiv.innerHTML = '<p class="card-help">No courses are currently available.</p>';
      return;
    }
    let html = '<div class="course-grid">';
    for (const c of courses) {
      const full = c.availableSpotsTotal <= 0 || c.acceptingEnrolments === false;
      html += `
        <div class="course-card ${full ? 'disabled' : ''}" data-course-id="${c.courseId}">
          <h4>${c.courseName}</h4>
          <p>${c.category || ''}</p>
          <span class="chip">${c.currentEnrolmentTotal}/${c.maxCapacityTotal} enrolled</span>
          ${full ? '<button class="btn" disabled>Full</button>' : '<button class="btn btn-primary">Choose</button>'}
        </div>`;
    }
    html += '</div>';
    courseListDiv.innerHTML = html;
    document.querySelectorAll('.course-card:not(.disabled) .btn-primary')
      .forEach((btn) => {
        btn.addEventListener('click', (e) => {
          const card = e.target.closest('.course-card');
          const courseId = card.getAttribute('data-course-id');
          const course = courses.find((x) => x.courseId === courseId);
          handleEnrolment(course);
        });
      });
  } catch (err) {
    courseListDiv.innerHTML = `<p class="card-help">Error loading courses: ${err.message}</p>`;
  }
}

// Enrol the student using RPC then show printable summary
async function handleEnrolment(course) {
  if (!course || !verifiedStudent) return;
  if (!confirm(`Confirm your selection: ${course.courseName}?`)) return;
  
  // Build a pseudo email (unique) since we are skipping OTP
  const pseudoEmail = (normaliseNameForMatching(verifiedStudent.forename || '')
    + '.' + normaliseNameForMatching(verifiedStudent.surname || verifiedStudent.name))
    .replace(/\s+/g, '') + '@cas.local';
  const formGroup = (verifiedStudent.form || verifiedStudent.form_group || 'L6');
  
  try {
    const { data, error } = await supabase.rpc('enrol_student_in_course', {
      p_course_id: course.courseId,
      p_student_email: pseudoEmail,
      p_student_name: verifiedStudent.name,
      p_form_group: formGroup,
    });
    if (error) throw error;
    if (!data || data.success === false) {
      throw new Error(data?.message || 'Could not enrol at this time');
    }
    renderEnrolmentSummary(course);
  } catch (err) {
    alert(`Enrolment failed: ${err.message}`);
  }
}

function renderEnrolmentSummary(course) {
  courseListDiv.innerHTML = `
    <div class="feedback bg-green-50" style="padding:1.25rem;border-radius:12px">
      <h4 style="font-size:1.25rem;margin:0 0 .5rem">Enrolment confirmed</h4>
      <p style="margin:.25rem 0"><strong>Pupil:</strong> ${verifiedStudent.name}</p>
      <p style="margin:.25rem 0"><strong>Form:</strong> ${verifiedStudent.form || 'L6'}</p>
      <p style="margin:.25rem 0"><strong>Course:</strong> ${course.courseName}</p>
      <p style="margin:.25rem 0"><strong>Category:</strong> ${course.category || ''}</p>
      <div style="margin-top:1rem">
        <button id="printSummary" class="btn btn-primary">Download / Print summary (PDF)</button>
      </div>
    </div>`;
  const btn = document.getElementById('printSummary');
  if (btn) btn.addEventListener('click', () => window.print());
}

